/**
 * Agent de veille immeubles de rapport
 * Pipeline : Gmail (alertes portails) -> extraction -> scoring Claude -> Supabase -> digest email
 *
 * Prérequis : voir README.md (OAuth Gmail, variables d'environnement)
 * Exécution : node index.js  (lancé chaque jour par GitHub Actions)
 */

import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import fs from "fs";

// ---------- Config ----------
const {
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,
  ANTHROPIC_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  DIGEST_TO, // ton adresse email pour le digest
} = process.env;

const GMAIL_QUERY =
  'newer_than:2d (from:leboncoin.fr OR from:seloger.com OR from:bienici.com OR from:guyhoquet.com)';const SCORING_PROMPT = fs.readFileSync("./prompt-scoring-immeubles.md", "utf8");
const CLAUDE_MODEL = "claude-sonnet-4-6";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------- Gmail ----------
function gmailClient() {
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth });
}

async function fetchAlertEmails(gmail) {
  const res = await gmail.users.messages.list({
    userId: "me",
    q: GMAIL_QUERY,
    maxResults: 25,
  });
  const messages = res.data.messages || [];
  const emails = [];
  for (const m of messages) {
    const full = await gmail.users.messages.get({
      userId: "me",
      id: m.id,
      format: "full",
    });
    emails.push({ id: m.id, text: extractText(full.data), from: header(full.data, "From") });
  }
  return emails;
}

function header(msg, name) {
  return msg.payload.headers.find((h) => h.name === name)?.value || "";
}

// Extrait le texte brut d'un email (parcourt les parties MIME)
function extractText(msg) {
  const parts = [];
  const walk = (p) => {
    if (!p) return;
    if (p.body?.data && (p.mimeType === "text/plain" || p.mimeType === "text/html")) {
      parts.push(Buffer.from(p.body.data, "base64url").toString("utf8"));
    }
    (p.parts || []).forEach(walk);
  };
  walk(msg.payload);
  return parts
    .join("\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#\d+;/g, " ")
    .replace(/\s{3,}/g, "\n")
    .slice(0, 30000);
}

// ---------- Claude ----------
async function claude(messages, system, maxTokens = 2000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("[") !== -1 && clean.indexOf("[") < (clean.indexOf("{") + 1 || Infinity)
    ? clean.indexOf("[")
    : clean.indexOf("{");
  return JSON.parse(clean.slice(start));
}

// Étape A : extraire les annonces d'un email d'alerte (Claude = parseur robuste)
async function extractListings(emailText) {
  const system = `Tu extrais des annonces immobilières depuis le texte brut d'un email d'alerte de portail (Leboncoin, SeLoger, Bien'ici).
Réponds UNIQUEMENT avec un tableau JSON (éventuellement vide) d'objets :
{"titre":"...","ville":"...","prix":123000,"surface":90,"url":"...","extrait":"texte descriptif disponible"}.
N'inclus que les IMMEUBLES (de rapport, entiers, plusieurs lots) ou biens divisibles évidents. Ignore appartements seuls, maisons familiales, publicités. Ne rien inventer : champ absent = null.`;
  const out = await claude([{ role: "user", content: emailText }], system, 3000);
  try {
    return parseJson(out);
  } catch {
    return [];
  }
}

// Étape B : scorer une annonce avec la grille
async function scoreListing(listing, loyersRef) {
  const user = `TABLE loyers_reference (calibrage actuel) :
${JSON.stringify(loyersRef)}

ANNONCE À ANALYSER :
${JSON.stringify(listing, null, 2)}`;
  const out = await claude([{ role: "user", content: user }], SCORING_PROMPT, 2500);
  return parseJson(out);
}

// ---------- Supabase ----------
function fingerprint(l) {
  const key = l.url || `${l.ville}|${l.prix}|${l.surface}|${(l.titre || "").slice(0, 40)}`;
  return createHash("sha256").update(key.toLowerCase()).digest("hex").slice(0, 32);
}

async function isNew(fp) {
  const { data } = await supabase.from("annonces").select("id").eq("fingerprint", fp).maybeSingle();
  return !data;
}

async function saveScored(listing, scoring, source) {
  await supabase.from("annonces").insert({
    fingerprint: fingerprint(listing),
    url: listing.url,
    source,
    titre: listing.titre,
    ville: scoring.ville || listing.ville,
    quartier: scoring.quartier,
    prix: scoring.prix || listing.prix,
    surface_totale: scoring.surface_totale || listing.surface,
    nb_lots: scoring.nb_lots,
    description_brute: listing.extrait,
    note: scoring.note,
    verdict: scoring.verdict,
    scoring,
  });
}

// ---------- Digest ----------
async function sendDigest(gmail, scored) {
  if (!scored.length) return;
  scored.sort((a, b) => b.scoring.note - a.scoring.note);
  const lines = scored.map((s) => {
    const sc = s.scoring;
    const rdt = sc.rendement_brut_pct ? `${sc.rendement_brut_pct.bas}-${sc.rendement_brut_pct.haut}%` : "n/a";
    return `<li><b>${sc.note}/10 — ${sc.verdict}</b> · ${s.listing.titre || ""} (${sc.ville}${sc.quartier ? ", " + sc.quartier : ""})<br>
Prix ${sc.prix?.toLocaleString("fr-FR")} € · ${sc.nb_lots || "?"} lots · Rendement estimé ${rdt}<br>
<i>${sc.justification}</i><br>
${sc.red_flags?.length ? "⚠️ " + sc.red_flags.join(" · ") + "<br>" : ""}
${s.listing.url ? `<a href="${s.listing.url}">Voir l'annonce</a>` : ""}
${sc.brouillon_email ? `<details><summary>📧 Brouillon email agent</summary><pre>${sc.brouillon_email}</pre></details>` : ""}
</li>`;
  });
  const html = `<h2>🏢 Veille immeubles — ${new Date().toLocaleDateString("fr-FR")}</h2>
<p>${scored.length} nouvelle(s) annonce(s) analysée(s)</p><ul>${lines.join("")}</ul>`;
  const raw = Buffer.from(
    [
      `To: ${DIGEST_TO}`,
      "Subject: =?utf-8?B?" + Buffer.from(`🏢 Veille immeubles — ${scored.length} annonce(s)`).toString("base64") + "?=",
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
    ].join("\r\n")
  ).toString("base64url");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
}

// ---------- Main ----------
async function main() {
  const gmail = gmailClient();
  const stats = { emails_lus: 0, annonces_extraites: 0, annonces_nouvelles: 0, erreurs: null };
  const scored = [];

  try {
    const { data: loyersRef } = await supabase.from("loyers_reference").select("*");
    const emails = await fetchAlertEmails(gmail);
    stats.emails_lus = emails.length;
    console.log(`${emails.length} email(s) d'alerte trouvés`);

    for (const email of emails) {
      const listings = await extractListings(email.text);
      stats.annonces_extraites += listings.length;

      for (const listing of listings) {
        const fp = fingerprint(listing);
        if (!(await isNew(fp))) continue; // déjà vu -> skip
        stats.annonces_nouvelles++;

        try {
          const scoring = await scoreListing(listing, loyersRef);
          const source = email.from.includes("leboncoin") ? "leboncoin"
            : email.from.includes("seloger") ? "seloger" : "autre";
          await saveScored(listing, scoring, source);
          scored.push({ listing, scoring });
          console.log(`✓ ${scoring.note}/10 — ${listing.titre}`);
        } catch (e) {
          console.error(`✗ Scoring échoué : ${listing.titre}`, e.message);
        }
      }
    }

    await sendDigest(gmail, scored);
    console.log(`Digest envoyé (${scored.length} annonces)`);
  } catch (e) {
    stats.erreurs = e.message;
    console.error("Erreur pipeline :", e);
    process.exitCode = 1;
  } finally {
    await supabase.from("runs").insert(stats);
  }
}

main();
