# PROMPT LOVABLE — KOVER.IA Demo

## Ce que tu copies-colles dans Lovable

---

Build a dark, cinematic, single-page demo app called **KOVER.IA** for a fintech investor pitch. This is a storytelling experience, not a dashboard. The jury is non-technical — they are VCs and finance professionals. The app must make them feel the problem emotionally, then show the solution clearly.

The app has **two acts** that auto-scroll or are triggered by a "Continue" button.

---

## GLOBAL STYLE

- Background: `#0a0a0f` (near black)
- Accent: `#ff3b3b` (red — danger) and `#00ff88` (green — safe)
- Font: Inter or Space Grotesk
- All monetary amounts animate counting up when they enter the viewport
- Subtle grid pattern overlay on background (like a Bloomberg terminal)
- Every section has a subtle fade-in animation when it appears

---

## ACT 1 — "LE BRAQUAGE" (The Heist)

### 1.1 — Opening Hero

Full-screen black section. Center of screen:

```
[Small red pulsing dot] INCIDENT DÉTECTÉ
13 MARS 2023 — 08:32:49 UTC
EULER FINANCE
```

Below, a large number that counts up dramatically from $0 to:

```
$197,000,000
```

Subtitle below: *"Volés en 13 minutes. Personne n'a rien vu."*

A single button at the bottom: **"Voir ce qui s'est passé →"**

---

### 1.2 — Who is Euler Finance?

A two-column section:

**Left column** — clean text:
```
Euler Finance
Protocole de prêt décentralisé
Audité. Certifié. Considéré sûr.

$800M de dépôts d'utilisateurs
Plus de 200 protocoles partenaires
Fondé en 2021 — Basé à Londres
```

**Right column** — a simple metric card:
```
TVL (Total Value Locked)
$854,000,000
Avant l'attaque
```

Small note below: *"Des milliers d'investisseurs individuels avaient déposé leurs économies ici."*

---

### 1.3 — The Timeline (The Heist in Steps)

A vertical timeline with 5 steps. Each step appears one by one with a 0.8s delay:

```
08:31:12 UTC
[ORANGE DOT] Un portefeuille inconnu emprunte 30,000,000 DAI
"Un Flash Loan — un emprunt instantané qui doit être remboursé dans la même transaction."

08:31:39 UTC
[ORANGE DOT] Le wallet interagit avec Euler 4 fois en 27 secondes
"Comportement anormal. Aucune alarme ne se déclenche."

08:32:14 UTC
[RED DOT] Exploitation du bug — Les réserves commencent à se vider
"Une faille dans le code permet de retirer plus que ce qui a été déposé."

08:32:49 UTC
[RED DOT — FLASHING] $197,000,000 extraits en une seule transaction
"13 minutes après le début de l'attaque. C'est terminé."

08:36:00 UTC
[DARK DOT] Les fonds sont dispersés vers 43 wallets en 4 minutes
"Le blanchiment commence immédiatement."
```

---

### 1.4 — Real Proof (Press Coverage)

A section titled: **"Ce que le monde a découvert — trop tard"**

Three "press card" components in a row, styled like news article previews:

**Card 1:**
```
[CoinDesk logo placeholder — grey rectangle]
13 Mars 2023

"Euler Finance suffers $197M exploit,
largest DeFi hack of 2023"
— CoinDesk
```

**Card 2:**
```
[Twitter/X icon]
@eulerfinance — 13 Mars 2023, 10:43 UTC

"We're aware of a serious incident 
which has led to an exploit on the 
Euler protocol..."

[Lien: twitter.com/eulerfinance]
```

**Card 3:**
```
[PeckShield icon — security firm]
@PeckShieldAlert — 13 Mars 2023

"#PeckShieldAlert Euler Finance has 
been exploited for ~$197M"

🔴 Alert émise : 2h11 APRÈS l'attaque
```

Below the cards, a red callout box:
```
⚠️ L'alerte de sécurité a été publiée 2 heures après le hack.
   Les fonds étaient déjà en cours de blanchiment.
```

---

### 1.5 — The Real Impact

Three large stat cards side by side:

```
$197M          43           2h11min
Volés          Wallets      Délai avant
               impliqués    la première alerte
```

Below them, a single powerful sentence centered on screen:
*"En crypto, 2 heures de retard, c'est l'éternité."*

Then a transition: **"Et si quelqu'un avait regardé ?"**

Button: **"Voir la solution →"**

---

---

## ACT 2 — "ET SI KOVER.IA AVAIT ÉTÉ LÀ ?" (The Solution)

### 2.1 — Transition Screen

Full-screen, brief (3 seconds auto-advance or button):

```
Nous allons rejouer l'attaque.
Cette fois, avec KOVER.IA.
```

Tagline: *"Ce n'est pas de la rétrodiction. C'est ce que notre système aurait vu — en temps réel."*

---

### 2.2 — Live Risk Score (THE WOW MOMENT)

This is the centerpiece of the demo. A full-width section showing a "replay" of the attack.

**Layout:**
- Left: A large circular score gauge (like a speedometer) that animates
- Right: A live event log that populates line by line

**The gauge:**
- Starts at score 5 (green zone: "NORMAL")
- Animates through the score timeline automatically every 2 seconds
- Color changes: green (0-30) → orange (30-70) → red (70-100)

**Score timeline data (animate in sequence, 2s each):**
```
08:30:19 UTC | Bloc 16817986 | Score: 5  | 🟢 Aucune anomalie détectée
08:31:04 UTC | Bloc 16817989 | Score: 14 | 🟡 Activité inhabituelle sur Euler
08:31:34 UTC | Bloc 16817991 | Score: 31 | 🟠 Flash Loan détecté: 30,000,000 DAI (Aave v2)
08:32:04 UTC | Bloc 16817993 | Score: 58 | 🔴 Séquence donate→liquidate anormale
08:32:34 UTC | Bloc 16817995 | Score: 79 | 🔴 Réserves en cours de vidage
08:32:49 UTC | Bloc 16817996 | Score: 96 | 🚨 CRITIQUE — ALERTE DÉCLENCHÉE
```

When score hits 96: the whole screen briefly flashes red, a loud (but tasteful) alert sound plays if possible, and the alert card appears.

---

### 2.3 — The Alert Card

A red-bordered card that "drops in" with a dramatic animation:

```
🚨 ALERTE CRITIQUE — KOVER.IA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
13 Mars 2023 — 08:32:49 UTC

Protocole ciblé :  Euler Finance
Attaquant :        0xb66c...95db
Type d'attaque :   Flashloan + Donate + Self-liquidation
Flash Loan :       30,000,000 DAI (Aave v2)
Score de risque :  96 / 100

Analyse IA :
"Pattern identique aux hacks Cream Finance (Oct 2021)
et Rari Capital (Apr 2022). Le wallet a interagi avec
Euler 4 fois en 2 blocs. Signature d'exploit connue."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ALERTES ENVOYÉES :
✅ Euler DAO           — Signal on-chain
✅ Circle (USDC)       — Demande de gel
✅ Binance             — Webhook reçu
✅ OFAC Watch          — Rapport généré

Temps de réaction : 15 secondes (1 bloc)
```

---

### 2.4 — Tainted Flow Graph (Fund Tracking)

Section title: **"Suivi des fonds en temps réel"**

An animated network graph that builds itself node by node:

**Nodes (appear one by one with a 0.5s delay):**
```
Center: [RED] Euler Finance (hacké) — $197M
  ↓
[DARK RED] Attaquant 0xb66c...95db — $197M
  ↓ (splits into branches)
  ├── [ORANGE] Wallet 0x8faa...c12b — $45M (USDC)
  │     └── [GREEN] Circle USDC Issuer ← "45M$ gelables ici"
  ├── [ORANGE] Wallet 0x3f9c...7e4a — $38M (DAI)
  │     └── [RED] Tornado Cash ← "Mixer — fonds perdus"
  ├── [ORANGE] Wallet 0x1a2b...9f3d — $32M (DAI)
  │     └── [RED] Tornado Cash
  ├── [ORANGE] Wallet 0x7d8e...2c1f — $27M (stETH)
  │     └── [YELLOW] BNB Bridge ← "Vers une autre blockchain"
  └── [ORANGE] ... 39 autres wallets — $55M
```

Below the graph, three colored stat boxes:

```
🔴 $40M        🟡 $112M       🟢 $45M
Perdus dans    Tracés et      Gelables
Tornado Cash   surveillés     immédiatement
```

---

### 2.5 — Side-by-Side Comparison

A clean table comparing "Sans KOVER.IA" vs "Avec KOVER.IA":

```
                    ❌ Sans KOVER.IA    ✅ Avec KOVER.IA
Délai d'alerte      2h 11min           15 secondes
Fonds gelables      $0                 $45,000,000
Fonds tracés        $0                 $112,000,000
Notification CEX    Manuelle (jours)   Automatique (15s)
Rapport OFAC        Jamais             Instantané
```

---

### 2.6 — Closing / CTA

Full-screen dark section, centered:

```
KOVER.IA

"On ne fait pas la police.
On donne aux bonnes personnes
l'information au bon moment."

━━━━━━━━━━━━━━━━━━━━━━

$197M volés en 2023.
$3.8 milliards volés en DeFi depuis 2020.

Chaque seconde compte.
```

Two buttons:
- **"Voir la démo technique"** (links to /docs or backend)
- **"Nous contacter"** (mailto or form)

---

## IMPORTANT TECHNICAL NOTES FOR LOVABLE

- All data is hardcoded (no API calls needed for the demo)
- The risk score animation in section 2.2 must play automatically when the section enters the viewport — use an Intersection Observer
- The network graph in 2.4 can use a simple animated SVG or a library like `react-force-graph` or just CSS-animated divs if simpler
- The timeline in 1.3 must stagger-animate (each item appears 0.8s after the previous)
- Mobile responsive is nice but not required — this will be demoed on a laptop
- No login, no forms, just the story
- Add a subtle "KOVER.IA | Hackathon Paris 2026" footer
