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
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>/gi, " LIEN:$1 ") // préserver les URLs des boutons/liens
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
{"titre":"...","reference":"JD-383","ville":"...","code_postal":"80000","quartier":null,"adresse":null,"prix":123000,"surface":90,"nb_lots":null,"dpe":null,"url":"...","extrait":"texte descriptif disponible"}.
IMPORTANT : les nombres à 5 chiffres commençant par le département (ex. 80000, 80080, 80090 pour Amiens, 29200 pour Brest, 76600 pour Le Havre) sont des CODES POSTAUX, jamais des prix ni des surfaces.
"reference" = la référence de l'annonce si présente (Réf, ref., n°...).
"url" = le lien de l'annonce, repérable par le marqueur LIEN: le plus proche du bien (bouton "Voir l'annonce", "Voir le bien"...). Prends l'URL complète même si c'est un lien de redirection/tracking. Ne JAMAIS laisser url à null si un LIEN: est présent près de l'annonce.
"adresse" = adresse ou rue si mentionnée. N'inclus que les IMMEUBLES (de rapport, entiers, plusieurs lots) ou biens divisibles évidents. Ignore appartements seuls, maisons familiales, publicités. Ne rien inventer : champ absent = null.`;
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
    // Coordonnées GPS de la carte (dans les scripts, à capturer avant leur suppression)
    const lat = html.match(/"?lat(?:itude)?"?\s*[:=]\s*"?(-?\d{1,2}\.\d{3,})/i)?.[1];
    const lng = html.match(/"?(?:lng|lon|longitude)"?\s*[:=]\s*"?(-?\d{1,3}\.\d{3,})/i)?.[1];
    const gps = lat && lng ? `\nCOORDONNEES GPS DU BIEN : ${lat}, ${lng}` : "";
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&amp;|&#\d+;|&[a-z]+;/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    return text.length < 200 ? null : text.slice(0, 12000) + gps;
  } catch {
    return null; // page bloquée/lente : on continue avec le mail seul
  }
}

// Étape A3 : condenser la page en fiche factuelle (Haiku, seulement si volumineuse)
async function condensePage(rawText) {
  if (!rawText) return null;
  if (rawText.length < 2500) return rawText;
  const system = `Tu extrais du texte brut d'une page web immobilière UNIQUEMENT les informations du bien principal : titre, référence, prix, surface, composition détaillée des lots, loyers actuels ou potentiels, DPE/GES, état et travaux, quartier/adresse/rue et coordonnées GPS si présentes, atouts. Ignore menus, footer, biens similaires, formulaires, mentions légales. Réponds en texte compact (10 lignes max), sans commentaire.`;
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

  const noteColor = (n) =>
    n >= 8 ? "#1a7f37" : n >= 6.5 ? "#5cb85c" : n >= 5 ? "#e0a800" : n >= 4 ? "#e07b39" : "#c0392b";
  const fmt = (v, s = "") => (v === null || v === undefined || v === "" ? "\u2014" : `${typeof v === "number" ? v.toLocaleString("fr-FR") : v}${s}`);

  const cards = scored.map((s) => {
    const sc = s.scoring, l = s.listing;
    const prix = sc.prix || l.prix;
    const surf = sc.surface_totale || l.surface;
    const pm2 = prix && surf ? Math.round(prix / surf) : null;
    const rdt = sc.rendement_brut_pct?.bas ? `${sc.rendement_brut_pct.bas}\u2013${sc.rendement_brut_pct.haut} %` : "\u2014";
    const loc = [sc.quartier || l.quartier, sc.adresse || l.adresse, l.code_postal, sc.ville || l.ville]
      .filter(Boolean).join(" \u00b7 ");
    const chip = 'display:inline-block;background:#f3f4f6;border-radius:6px;padding:3px 8px;margin:2px 4px 2px 0;font:400 13px -apple-system,sans-serif';
    return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto 14px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px">
<tr><td style="padding:14px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="width:56px;vertical-align:top">
      <div style="width:48px;height:48px;border-radius:10px;background:${noteColor(sc.note || 0)};color:#fff;font:700 20px/48px -apple-system,sans-serif;text-align:center">${sc.note ?? "?"}</div>
    </td>
    <td style="vertical-align:top;padding-left:12px">
      <div style="font:700 15px -apple-system,sans-serif;color:#111">R\u00e9f ${fmt(sc.reference || l.reference)} \u00b7 ${fmt(prix, " \u20ac")}</div>
      <div style="font:400 13px -apple-system,sans-serif;color:#6b7280;margin-top:2px">\ud83d\udccd ${loc || "\u2014"}</div>
    </td>
  </tr></table>
  <div style="margin-top:10px">
    <span style="${chip}">${fmt(surf, " m\u00b2")}</span><span style="${chip}">${fmt(pm2, " \u20ac/m\u00b2")}</span><span style="${chip}">\ud83c\udfe0 ${fmt(sc.nb_lots || l.nb_lots)} lots</span><span style="${chip}">DPE ${fmt(sc.dpe || l.dpe)}</span><span style="${chip};background:#eef6ee">\ud83d\udcc8 ${rdt}</span>
  </div>
  <div style="margin-top:10px;font:400 13px/1.45 -apple-system,sans-serif;color:#374151">${sc.justification || ""}</div>
  ${sc.red_flags?.length ? `<div style="margin-top:6px;font:400 12px/1.4 -apple-system,sans-serif;color:#b45309">\u26a0\ufe0f ${sc.red_flags.slice(0, 3).join(" \u00b7 ")}</div>` : ""}
  ${l.url ? `<div style="margin-top:10px"><a href="${l.url}" style="display:inline-block;background:#2563eb;color:#fff;border-radius:8px;padding:8px 14px;font:600 13px -apple-system,sans-serif;text-decoration:none">Voir l'annonce</a></div>` : ""}
  ${sc.brouillon_email ? `<details style="margin-top:10px"><summary style="cursor:pointer;color:#2563eb;font:600 13px -apple-system,sans-serif">\ud83d\udce7 Email de qualification pr\u00eat</summary><pre style="white-space:pre-wrap;font:400 12px/1.4 -apple-system,sans-serif;background:#f6f8fa;padding:10px;border-radius:8px;margin-top:6px">${sc.brouillon_email}</pre></details>` : ""}
</td></tr>
</table>`;
  });

  const html = `<body style="margin:0;padding:16px 8px;background:#f3f4f6">
<div style="max-width:600px;margin:0 auto">
<h2 style="font:700 18px -apple-system,sans-serif;color:#111;margin:0 0 2px">\ud83c\udfe2 Veille immeubles \u2014 ${new Date().toLocaleDateString("fr-FR")}</h2>
<p style="font:400 13px -apple-system,sans-serif;color:#6b7280;margin:0 0 14px">${scored.length} nouvelle(s) annonce(s), tri\u00e9es par note</p>
${cards.join("")}
</div></body>`;

  const raw = Buffer.from(
    [
      `To: ${DIGEST_TO}`,
      "Subject: =?utf-8?B?" + Buffer.from(`\ud83c\udfe2 Veille immeubles \u2014 ${scored.length} annonce(s)`).toString("base64") + "?=",
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
    ].join("\\r\\n")
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
          console.log(`  fiche ${listing.reference || listing.titre || "?"}: ${listing.fiche ? "récupérée (" + listing.fiche.length + " car.)" : "ABSENTE"} — url: ${listing.url || "AUCUNE"}`);
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
