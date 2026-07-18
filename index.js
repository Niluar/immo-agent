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
  'newer_than:2d (from:leboncoin.fr OR from:seloger.com OR from:bienici.com OR from:guyhoquet.com)';
const SCORING_PROMPT = fs.readFileSync("./prompt-scoring-immeubles.md", "utf8");
const CLAUDE_MODEL = "claude-sonnet-4-6";
const EXTRACT_MODEL = "claude-haiku-4-5";  // extraction emails + nettoyage pages
const SCORE_MODEL = "claude-haiku-4-5";    // scoring de masse
const VALIDATE_THRESHOLD = 6.5;            // au-dessus : validation Sonnet
const BLOCKED_FETCH = ["leboncoin.fr", "seloger.com", "bienici.com"]; // anti-bot : fetch inutile

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
async function claude(messages, system, maxTokens = 2000, model = CLAUDE_MODEL) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(90000),
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

// Extrait un bloc JSON équilibré ({...} ou [...]) même entouré de texte parasite
function extractBalanced(text, open, close) {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const obj = extractBalanced(clean, "{", "}");
  const arr = extractBalanced(clean, "[", "]");
  // priorité au bloc qui apparaît en premier, avec repli sur l'autre
  const first = arr && (!obj || clean.indexOf("[") < clean.indexOf("{")) ? [arr, obj] : [obj, arr];
  for (const candidate of first) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch {}
  }
  throw new Error("JSON invalide dans la réponse du modèle");
}

// Étape A : extraire les annonces d'un email d'alerte (Claude = parseur robuste)
async function extractListings(emailText) {
  const system = `Tu extrais des annonces immobilières depuis le texte brut d'un email d'alerte (portail ou agence).
Réponds UNIQUEMENT avec un tableau JSON (éventuellement vide) d'objets :
{"titre":"...","reference":"JD-383","ville":"...","code_postal":"80000","quartier":null,"prix":123000,"surface":90,"nb_lots":null,"dpe":null,"url":"...","extrait":"texte descriptif disponible"}.
IMPORTANT : les nombres à 5 chiffres commençant par le département (ex. 80000, 80080, 80090 pour Amiens, 29200 pour Brest, 76600 pour Le Havre) sont des CODES POSTAUX, jamais des prix ni des surfaces.
"reference" = la référence de l'annonce si présente (Réf, ref., n°...). N'inclus que les IMMEUBLES (de rapport, entiers, plusieurs lots) ou biens divisibles évidents. Ignore appartements seuls, maisons familiales, publicités. Ne rien inventer : champ absent = null.`;
  const out = await claude([{ role: "user", content: emailText }], system, 3000, EXTRACT_MODEL);
  try {
    return parseJson(out);
  } catch {
    return [];
  }
}

// Étape A2 : récupérer la fiche complète de l'annonce (sites d'agences)
async function fetchListingPage(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    if (BLOCKED_FETCH.some((d) => host.includes(d))) return null;
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; immo-agent/1.0)" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&amp;|&#\d+;|&[a-z]+;/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    return text.length < 200 ? null : text.slice(0, 12000);
  } catch {
    return null; // page bloquée/lente : on continue avec le mail seul
  }
}

// Étape A3 : condenser la page en fiche factuelle (Haiku, seulement si volumineuse)
async function condensePage(rawText) {
  if (!rawText) return null;
  if (rawText.length < 2500) return rawText;
  const system = `Tu extrais du texte brut d'une page web immobilière UNIQUEMENT les informations du bien principal : titre, référence, prix, surface, composition détaillée des lots, loyers actuels ou potentiels, DPE/GES, état et travaux, quartier/adresse, atouts. Ignore menus, footer, biens similaires, formulaires, mentions légales. Réponds en texte compact (10 lignes max), sans commentaire.`;
  try {
    return await claude([{ role: "user", content: rawText }], system, 800, EXTRACT_MODEL);
  } catch {
    return rawText.slice(0, 3000);
  }
}

// Étape B : scorer une annonce avec la grille
async function scoreListing(listing, loyersRef) {
  const { fiche, ...data } = listing;
  const user = `TABLE loyers_reference (calibrage actuel) :
${JSON.stringify(loyersRef)}

ANNONCE À ANALYSER :
${JSON.stringify(data, null, 2)}
${fiche ? `\nFICHE COMPLÈTE (récupérée sur la page de l'annonce — source la plus fiable) :\n${fiche}` : ""}

RAPPEL : réponds UNIQUEMENT avec l'objet JSON, sans aucun texte avant ou après, sans backticks.`;
  // Tri de masse par Haiku
  let scoring = parseJson(await claude([{ role: "user", content: user }], SCORING_PROMPT, 2500, SCORE_MODEL));
  scoring.modele = "haiku";
  // Escalade : les candidats sérieux sont re-validés par Sonnet (note + brouillon plus fins)
  if ((scoring.note ?? 0) >= VALIDATE_THRESHOLD) {
    try {
      const s2 = parseJson(await claude([{ role: "user", content: user }], SCORING_PROMPT, 2500));
      s2.modele = "sonnet";
      s2.note_haiku = scoring.note;
      scoring = s2;
    } catch {} // si la validation échoue, on garde la note Haiku
  }
  return scoring;
}

// ---------- Supabase ----------
function fingerprint(l) {
  // Priorité : référence agence (stable entre emails) > URL > combinaison ville/prix/surface
  const key = l.reference
    ? `ref|${(l.ville || "").trim()}|${l.reference.trim()}`
    : l.url || `${l.ville}|${l.prix}|${l.surface}|${(l.titre || "").slice(0, 40)}`;
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
  scored.sort((a, b) => (b.scoring.note || 0) - (a.scoring.note || 0));

  // Couleur de la note : rouge (<=3) -> orange -> jaune -> vert clair -> vert (>=8)
  const noteColor = (n) =>
    n >= 8 ? "#1a7f37" : n >= 6.5 ? "#5cb85c" : n >= 5 ? "#e0a800" : n >= 4 ? "#e07b39" : "#c0392b";
  const fmt = (v, suffix = "") => (v === null || v === undefined || v === "" ? "—" : `${typeof v === "number" ? v.toLocaleString("fr-FR") : v}${suffix}`);

  const rows = scored.map((s) => {
    const sc = s.scoring, l = s.listing;
    const prix = sc.prix || l.prix;
    const surf = sc.surface_totale || l.surface;
    const pm2 = prix && surf ? Math.round(prix / surf) : null;
    const rdt = sc.rendement_brut_pct?.bas ? `${sc.rendement_brut_pct.bas}–${sc.rendement_brut_pct.haut} %` : "—";
    const loc = [sc.quartier || l.quartier, l.code_postal].filter(Boolean).join(" · ") || sc.ville || l.ville;
    const mail = sc.brouillon_email
      ? `<details style="margin-top:4px"><summary style="cursor:pointer;color:#2563eb;font-size:12px">📧 Email prêt</summary><pre style="white-space:pre-wrap;font-size:11px;background:#f6f8fa;padding:8px;border-radius:6px">${sc.brouillon_email}</pre></details>`
      : "";
    const flags = sc.red_flags?.length
      ? `<div style="font-size:11px;color:#b45309;margin-top:2px">⚠️ ${sc.red_flags.slice(0, 3).join(" · ")}</div>`
      : "";
    return `<tr style="border-bottom:1px solid #e5e7eb">
<td style="padding:8px;text-align:center;white-space:nowrap"><span style="display:inline-block;min-width:44px;padding:4px 8px;border-radius:6px;background:${noteColor(sc.note || 0)};color:#fff;font-weight:700">${sc.note ?? "?"}</span></td>
<td style="padding:8px;font-size:13px"><b>${fmt(l.reference)}</b><br><span style="color:#6b7280;font-size:12px">${loc}</span></td>
<td style="padding:8px;text-align:right;white-space:nowrap">${fmt(prix, " €")}<br><span style="color:#6b7280;font-size:12px">${fmt(surf, " m²")} · ${fmt(pm2, " €/m²")}</span></td>
<td style="padding:8px;text-align:center">${fmt(sc.nb_lots || l.nb_lots)}</td>
<td style="padding:8px;text-align:center">${fmt(sc.dpe || l.dpe)}</td>
<td style="padding:8px;text-align:center;white-space:nowrap">${rdt}</td>
<td style="padding:8px;font-size:12px;max-width:340px">${sc.justification || ""}${flags}${l.url ? `<div style="margin-top:2px"><a href="${l.url}" style="font-size:12px">Voir l'annonce</a></div>` : ""}${mail}</td>
</tr>`;
  });

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:960px">
<h2 style="margin-bottom:4px">🏢 Veille immeubles — ${new Date().toLocaleDateString("fr-FR")}</h2>
<p style="color:#6b7280;margin-top:0">${scored.length} nouvelle(s) annonce(s) · triées par note</p>
<table style="border-collapse:collapse;width:100%">
<thead><tr style="background:#f6f8fa;text-align:left">
<th style="padding:8px">Note</th><th style="padding:8px">Réf · Lieu</th><th style="padding:8px;text-align:right">Prix · Surface</th><th style="padding:8px">Lots</th><th style="padding:8px">DPE</th><th style="padding:8px">Rendement</th><th style="padding:8px">Synthèse</th>
</tr></thead>
<tbody>${rows.join("")}</tbody>
</table></div>`;

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
        if (stats.annonces_nouvelles >= 15) break; // plafond de sécurité par run
        stats.annonces_nouvelles++;

        try {
          // Enrichissement : fiche complète depuis la page de l'annonce (si accessible)
          listing.fiche = await condensePage(await fetchListingPage(listing.url));
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
