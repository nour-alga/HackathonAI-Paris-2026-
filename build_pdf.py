# -*- coding: utf-8 -*-
"""Build RAPPORT_KOVER_IA_COMPLET.pdf using fpdf2."""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from fpdf import FPDF

INK = (12, 18, 28)
GOLD = (196, 142, 42)
GREY = (120, 128, 140)
BG = (246, 246, 242)
GREEN = (63, 163, 108)
ALERT = (226, 58, 58)


class Report(FPDF):
    def header(self):
        if self.page_no() == 1:
            return
        self.set_font(FONT, "B", 9)
        self.set_text_color(*INK)
        self.set_xy(15, 8)
        self.cell(0, 6, "KOVER.IA")
        self.set_font(FONT, "", 9)
        self.set_text_color(*GREY)
        self.set_xy(-80, 8)
        self.cell(65, 6, "Hackathon AI Paris 2026", align="R")
        self.set_draw_color(*GREY)
        self.set_line_width(0.2)
        self.line(15, 15, 195, 15)
        self.set_text_color(*INK)

    def footer(self):
        if self.page_no() == 1:
            return
        self.set_y(-12)
        self.set_font(FONT, "", 9)
        self.set_text_color(*GREY)
        self.cell(0, 6, str(self.page_no()), align="C")


pdf = Report(format="A4", unit="mm")
pdf.set_auto_page_break(auto=True, margin=18)
pdf.set_margins(20, 20, 20)
pdf.set_title("KOVER.IA - Rapport projet complet")
pdf.set_author("KOVER.IA")

# Unicode fonts (Arial)
pdf.add_font("Arial", "", r"C:\Windows\Fonts\arial.ttf")
pdf.add_font("Arial", "B", r"C:\Windows\Fonts\arialbd.ttf")
pdf.add_font("Arial", "I", r"C:\Windows\Fonts\ariali.ttf")
FONT = "Arial"

# ---------- COVER ----------
pdf.add_page()
pdf.set_y(60)
pdf.set_font(FONT, "B", 38)
pdf.set_text_color(*INK)
pdf.cell(0, 16, "KOVER.IA", align="C", new_x="LMARGIN", new_y="NEXT")
pdf.ln(2)
pdf.set_draw_color(*GOLD)
pdf.set_line_width(0.7)
pdf.line(85, pdf.get_y(), 125, pdf.get_y())
pdf.ln(8)
pdf.set_font(FONT, "B", 18)
pdf.cell(0, 10, "Rapport projet complet", align="C", new_x="LMARGIN", new_y="NEXT")
pdf.set_font(FONT, "", 12)
pdf.set_text_color(*GREY)
pdf.cell(0, 7, "Problématique, solution, architecture,", align="C", new_x="LMARGIN", new_y="NEXT")
pdf.cell(0, 7, "positionnement et stratégie commerciale", align="C", new_x="LMARGIN", new_y="NEXT")
pdf.ln(40)

# Cover box
pdf.set_fill_color(*BG)
pdf.set_draw_color(*INK)
pdf.set_line_width(0.3)
box_x, box_y, box_w, box_h = 45, pdf.get_y(), 120, 28
pdf.rect(box_x, box_y, box_w, box_h, "DF")
pdf.set_xy(box_x, box_y + 4)
pdf.set_font(FONT, "B", 12)
pdf.set_text_color(*INK)
pdf.cell(box_w, 6, "Hackathon AI Paris 2026", align="C", new_x="LMARGIN", new_y="NEXT")
pdf.set_x(box_x)
pdf.set_font(FONT, "", 10)
pdf.ln(2)
pdf.set_x(box_x)
pdf.cell(box_w, 5, "Détection en temps réel du blanchiment crypto", align="C", new_x="LMARGIN", new_y="NEXT")
pdf.set_x(box_x)
pdf.cell(box_w, 5, "et des attaques flashloan par intelligence artificielle.", align="C", new_x="LMARGIN", new_y="NEXT")

pdf.set_y(-30)
pdf.set_font(FONT, "", 9)
pdf.set_text_color(*GREY)
pdf.cell(0, 6, "Avril 2026   |   Version 1.0   |   kover.ia", align="C")


# ---------- HELPERS ----------
def h2(title):
    pdf.ln(6)
    pdf.set_font(FONT, "B", 16)
    pdf.set_text_color(*INK)
    pdf.cell(0, 9, title, new_x="LMARGIN", new_y="NEXT")
    pdf.set_draw_color(*GOLD)
    pdf.set_line_width(0.6)
    y = pdf.get_y()
    pdf.line(20, y, 190, y)
    pdf.ln(3)


def h3(title):
    pdf.ln(2)
    pdf.set_font(FONT, "B", 12)
    pdf.set_text_color(*INK)
    pdf.cell(0, 7, title, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(1)


def h4(title):
    pdf.ln(1)
    pdf.set_font(FONT, "B", 11)
    pdf.set_text_color(*GOLD)
    pdf.cell(0, 6, title, new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(*INK)


def p(text):
    pdf.set_font(FONT, "", 10.5)
    pdf.set_text_color(*INK)
    pdf.multi_cell(0, 5.6, text, align="J")
    pdf.ln(1)


def bullets(items, ordered=False):
    pdf.set_font(FONT, "", 10.5)
    pdf.set_text_color(*INK)
    for i, it in enumerate(items, 1):
        marker = f"{i}. " if ordered else "•  "
        pdf.set_x(22)
        pdf.cell(7, 5.6, marker)
        x = pdf.get_x()
        y = pdf.get_y()
        pdf.set_xy(x, y)
        pdf.multi_cell(0, 5.6, it, align="J")
    pdf.ln(1)


def insight(text):
    pdf.ln(2)
    x0 = 20
    w = 170
    pdf.set_font(FONT, "", 10)
    pdf.set_text_color(*INK)
    # measure height
    y_start = pdf.get_y()
    pdf.set_xy(x0 + 4, y_start + 3)
    pdf.multi_cell(w - 8, 5.2, text)
    y_end = pdf.get_y()
    h = y_end - y_start + 3
    # draw box
    pdf.set_fill_color(*BG)
    pdf.set_draw_color(*INK)
    pdf.set_line_width(0.2)
    pdf.rect(x0, y_start, w, h, "D")
    pdf.set_xy(x0 + 4, y_start + 3)
    pdf.multi_cell(w - 8, 5.2, text)
    pdf.ln(3)


def quote(text):
    pdf.ln(2)
    x0 = 20
    w = 170
    pdf.set_font(FONT, "I", 10.5)
    pdf.set_text_color(*INK)
    y_start = pdf.get_y()
    pdf.set_xy(x0 + 6, y_start + 3)
    pdf.multi_cell(w - 10, 5.4, text)
    y_end = pdf.get_y()
    h = y_end - y_start + 3
    pdf.set_draw_color(*GOLD)
    pdf.set_line_width(1.2)
    pdf.line(x0, y_start, x0, y_start + h)
    pdf.ln(3)


def table(headers, rows, widths):
    pdf.ln(1)
    pdf.set_font(FONT, "B", 10)
    pdf.set_text_color(*INK)
    pdf.set_fill_color(*BG)
    pdf.set_draw_color(*INK)
    pdf.set_line_width(0.3)
    # header row
    line_h = 6
    x = pdf.get_x()
    y = pdf.get_y()
    pdf.line(20, y, 20 + sum(widths), y)
    for i, hd in enumerate(headers):
        pdf.cell(widths[i], line_h + 1, hd, fill=True)
    pdf.ln(line_h + 1)
    pdf.line(20, pdf.get_y(), 20 + sum(widths), pdf.get_y())
    # rows
    pdf.set_font(FONT, "", 9.5)
    for row in rows:
        # measure heights for wrap
        heights = []
        for i, cell in enumerate(row):
            lines = pdf.multi_cell(widths[i], 5, cell, dry_run=True, output="LINES")
            heights.append(len(lines) * 5)
        rh = max(heights) + 1
        if pdf.get_y() + rh > 275:
            pdf.add_page()
        x0 = 20
        y0 = pdf.get_y()
        for i, cell in enumerate(row):
            pdf.set_xy(x0, y0)
            pdf.multi_cell(widths[i], 5, cell)
            x0 += widths[i]
        pdf.set_xy(20, y0 + rh)
        pdf.set_draw_color(220, 220, 220)
        pdf.line(20, pdf.get_y(), 20 + sum(widths), pdf.get_y())
    pdf.set_draw_color(*INK)
    pdf.line(20, pdf.get_y(), 20 + sum(widths), pdf.get_y())
    pdf.ln(3)


# ---------- TOC ----------
pdf.add_page()
h2("Table des matières")
toc = [
    "1. Problématique : quel problème règle-t-on ?",
    "2. Limites des solutions actuelles",
    "3. Notre solution : KOVER.IA",
    "4. Architecture technique",
    "5. Concurrence et positionnement",
    "6. Coûts de production",
    "7. Comment on vend : à qui, pourquoi",
    "8. Pourquoi nous : crédibilité du projet livré",
]
pdf.set_font(FONT, "", 11)
pdf.set_text_color(*INK)
for entry in toc:
    pdf.set_x(22)
    pdf.cell(0, 7, entry, new_x="LMARGIN", new_y="NEXT")


# ---------- 1 PROBLEMATIQUE ----------
pdf.add_page()
h2("1. Problématique : quel problème règle-t-on ?")

h3("Un secteur DeFi structurellement vulnérable")
p("La finance décentralisée (DeFi) gère aujourd'hui plus de 120 milliards de dollars de "
  "valeur verrouillée à travers des protocoles ouverts opérant 24h/24 sur des blockchains "
  "publiques. En 2024, selon Chainalysis, plus de 2,2 milliards de dollars ont été volés sur "
  "des protocoles DeFi, soit +21 % par rapport à 2023. À ces vols directs s'ajoute un phénomène "
  "encore plus coûteux : le blanchiment des fonds dérobés, qui se déroule en quelques minutes "
  "via mixeurs, bridges cross-chain et CEX peu régulés.")

h3("Le problème central : la vélocité")
p("Le blanchiment crypto suit un patron stéréotypé observé sur tous les hacks majeurs "
  "(Euler, Ronin, Wormhole, Curve) :")
bullets([
    "Splitting : éclatement sur 4 à 12 wallets en moins de deux minutes.",
    "Mixing : 5 à 20 transactions intermédiaires via Tornado Cash, Railgun ou wallets jetables.",
    "Bridging : transit cross-chain (BSC, Polygon, Arbitrum) via Wormhole, Stargate, Synapse.",
    "Off-ramp : dépôt sur un CEX peu régulé pour conversion en fiat.",
], ordered=True)
p("L'ensemble se déroule en 15 à 90 minutes. Aucune équipe humaine ne peut suivre ce rythme. "
  "Quand un analyste ouvre l'investigation, les fonds sont déjà dans un mixeur ou sur un bridge.")

h3("Une seconde menace : les flashloan attacks")
p("En parallèle, les protocoles DeFi sont la cible d'attaques par flashloan : emprunt non "
  "collatéralisé d'une somme massive, manipulation d'un oracle ou d'un pool, remboursement "
  "dans la même transaction. Tout se joue dans le mempool en quelques centaines de millisecondes.")

quote("Le problème central que nous adressons est donc double : un problème de détection "
      "(voir le blanchiment ou l'attaque émerger en temps réel) et un problème de décision "
      "(produire une recommandation actionnable assez vite pour qu'elle soit utile).")


# ---------- 2 LIMITES ----------
pdf.add_page()
h2("2. Limites des solutions actuelles")
p("Les outils AML on-chain dominants (Chainalysis Reactor, TRM Labs, Elliptic Lens, Forta) "
  "reposent sur trois piliers historiques :")
bullets([
    "Listes d'adresses étiquetées maintenues manuellement (sanctions OFAC, mixeurs connus, hackers).",
    "Heuristiques de propagation déterministes (hops, montants, fréquence).",
    "Tableaux de bord d'investigation optimisés pour l'analyse rétrospective.",
])
h4("1. Approche rétrospective, pas prédictive")
p("Ces outils étiquettent après les faits. Ils ne modélisent pas le graphe comme un système "
  "dynamique et ne prédisent jamais la prochaine étape probable d'un flux suspect.")
h4("2. Aucune représentation latente apprise")
p("Les wallets sont définis par des labels manuels. Un wallet inconnu mais structurellement "
  "suspect ne sera jamais signalé tant qu'un analyste ne l'aura pas classé.")
h4("3. Latence en minutes, pas en secondes")
p("Chainalysis produit des rapports en heures, TRM en minutes. La réponse opérationnelle est "
  "rendue impossible.")
h4("4. Black-box non auditable")
p("Les décisions sont opaques. MiCA et l'AMLR-2024 exigent désormais une traçabilité "
  "algorithmique vérifiable que les acteurs en place ne fournissent qu'au prix d'audits "
  "externes coûteux.")
insight("Le vide à combler. Il n'existe AUCUN produit grand public combinant représentations "
        "apprises sur graphe, prédiction séquentielle de la trajectoire des fonds, narratif LLM "
        "exploitable, et provenance cryptographique vérifiable, en moins de cinq secondes.")


# ---------- 3 SOLUTION ----------
pdf.add_page()
h2("3. Notre solution : KOVER.IA")
h3("Philosophie produit")
p("KOVER.IA est un capteur prédictif temps réel qui observe le flux Ethereum, modélise le "
  "graphe émergent, prédit la trajectoire des fonds suspects, et produit un rapport d'incident "
  "en moins de 5 secondes. La solution combine deux modules synergiques :")
bullets([
    "Module AML : détection et prédiction du blanchiment sur le graphe des transactions confirmées.",
    "Module BFD (Behavioral Flow Detection) : sentinel mempool spécialisé dans l'interception des flashloan attacks avant minage.",
])
h3("Ce que nous délivrons concrètement")
bullets([
    "Un score de fraude par wallet, calculé toutes les 5 secondes.",
    "Une prédiction de la prochaine destination probable.",
    "Un rapport d'incident en langage naturel streamé token-par-token.",
    "Un halt automatique en cas de flashloan critique mempool.",
    "Un manifest cryptographique signé HMAC-SHA256 prouvant la provenance.",
], ordered=True)


# ---------- 4 ARCHITECTURE ----------
pdf.add_page()
h2("4. Architecture technique")
h3("Pipeline multi-modèle orchestré")
table(
    ["Modèle", "Rôle", "Fréquence"],
    [
        ["GAT (Graph Attention Network)",
         "Score de fraude par wallet ; capte les dépendances structurelles du graphe (un wallet propre individuellement peut être condamné par ses voisins).",
         "5 s"],
        ["LSTM séquentiel",
         "Prédit la prochaine destination du flux à partir des 5 derniers wallets pondérés par le score GAT.",
         "6 s"],
        ["Qwen 3 235B (Cerebras)",
         "Génère un rapport d'incident structuré en streaming token-par-token.",
         "30 s"],
    ],
    [55, 100, 15],
)
p("Le pipeline ingère un flux Ethereum-like calibré sur le dataset Salam Ammari (73 034 wallets, "
  "71 250 transactions, ratio fraude environ 3,7 %). Un graphe roulant de 50 noeuds est maintenu "
  "en mémoire sur 4 tiers (source, splitters, mixeurs, terminaux).")

h3("Module Behavioral Flow Detection (BFD)")
p("Le sentinel kover-bfd-mev :")
bullets([
    "Pré-filtre des sélecteurs de méthodes (Aave, dYdX, Balancer, Maker).",
    "Simulation eth_call sans diffusion.",
    "Verdict IA Cerebras (Qwen) : sévérité LOW / MEDIUM / CRITICAL + exploit class.",
    "Diffusion via Server-Sent Events vers un dashboard temps réel.",
])
p("Performance mesurée : 6,5 M événements/s, latence de l'ordre de la dizaine de millisecondes.")

h3("Provenance cryptographique")
p("Chaque inférence est attachée à un manifest signé HMAC-SHA256 contenant l'empreinte SHA-256 "
  "des fichiers de poids, les métadonnées d'entraînement, la liste des inférences récentes. "
  "Un auditeur externe peut recalculer le HMAC et vérifier qu'aucune prédiction n'a été "
  "falsifiée.")

h3("Métriques de performance mesurées")
table(
    ["Métrique", "Détail", "Valeur"],
    [
        ["GAT - accuracy validation", "14k wallets test", "97,0 %"],
        ["GAT - recall fraude", "classe minoritaire", "94,0 %"],
        ["LSTM - accuracy par classe", "clean / Scam / Phish", "89 / 91 / 58 %"],
        ["Cerebras - débit", "Qwen 3 235B streaming", "49 tokens/s"],
        ["Pipeline complet", "cycle bout-en-bout", "< 5 s"],
        ["Couverture tests", "80 tests pytest", "95-100 %"],
    ],
    [60, 75, 35],
)


# ---------- 5 CONCURRENCE ----------
pdf.add_page()
h2("5. Concurrence et positionnement")
h3("Cartographie du marché")
table(
    ["Acteur", "Positionnement", "Cible"],
    [
        ["Chainalysis", "Compliance & forensique", "Banques, gouvernements"],
        ["TRM Labs", "Risk scoring quasi temps réel", "Exchanges, fintechs"],
        ["Elliptic", "AML transaction monitoring", "Institutions financières"],
        ["Forta Network", "Détection on-chain décentralisée", "Protocoles, DAO"],
        ["Hexagate / Hypernative", "Détection d'attaques DeFi", "Équipes sécurité"],
    ],
    [45, 70, 55],
)

h3("Comparatif fonctionnel")
table(
    ["", "Chainalysis", "TRM", "Forta", "KOVER.IA"],
    [
        ["Score IA appris (GNN)", "non", "non", "partiel", "OUI"],
        ["Prédiction destination (LSTM)", "non", "non", "non", "OUI"],
        ["Rapport LLM streamé", "non", "non", "non", "OUI"],
        ["Manifest crypto signé", "non", "non", "non", "OUI"],
        ["Sentinel flashloan", "non", "partiel", "OUI", "OUI"],
        ["Latence médiane d'alerte", "minutes", "secondes", "secondes", "< 5 s"],
        ["Open source partiel", "non", "non", "partiel", "OUI"],
    ],
    [60, 28, 22, 22, 38],
)

h3("Pourquoi nous : 4 axes différenciants")
h4("1. La triple couche IA (graphe + séquence + langage)")
p("Aucun concurrent ne combine aujourd'hui un GNN, un RNN séquentiel et un LLM en pipeline "
  "temps réel orchestré. Chaque modèle existe isolément ; leur orchestration est notre apport.")
h4("2. Provenance cryptographique native")
p("Le manifest HMAC répond directement à l'exigence MiCA / AMLR-2024. Là où les concurrents "
  "répondent par audit externe, nous répondons par preuve vérifiable.")
h4("3. Latence sub-5 secondes bout-en-bout")
p("Cette latence déplace le cas d'usage de l'investigation post-mortem vers la réponse "
  "opérationnelle. C'est un changement de catégorie produit.")
h4("4. Surface d'intégration ouverte")
p("WebSocket public + endpoint REST signé. Toute DAO, oracle ou multi-sig peut consommer nos "
  "verdicts sans contrat préalable, modèle natif crypto contrairement aux SDK propriétaires "
  "des acteurs établis.")


# ---------- 6 COUTS ----------
pdf.add_page()
h2("6. Coûts de production")
p("Le COGS d'une instance Defend en production est dominé par trois postes :")
bullets([
    "Inférence Cerebras : environ 7 $/M tokens. Pattern 1 rapport / 30s, 250 tokens/rapport, "
    "24x7 -> environ 720 M tokens/an, soit 5 040 $/an.",
    "Hébergement backend : AWS m6a.large + Redis environ 80 $/mois, 3 zones DR : 2 880 $/an.",
    "Données on-chain : QuickNode Build (mempool + archive) à 99 $/mois : 1 188 $/an par chaîne.",
])
p("COGS consolidé : environ 9 100 $/an pour un client Defend qui paie 144 k$/an. Soit une "
  "marge brute > 93 %, typique d'un SaaS B2B deeptech, qui finance R&D ML, expansion produit "
  "(Solana, Bitcoin) et sales.")


# ---------- 7 VENTE ----------
pdf.add_page()
h2("7. Comment on vend : à qui, pourquoi")
h3("À qui : nos 4 segments cibles")
table(
    ["Segment", "Besoin principal", "ARR cible"],
    [
        ["Protocoles DeFi (TVL > 100 M$)", "Surveillance flashloan + réponse auto", "60-250 k$"],
        ["Exchanges régulés (CEX)", "Filtre AML temps réel sur dépôts entrants", "120-500 k$"],
        ["DAO de gouvernance", "Alerte indépendante pour vote on-chain", "24-80 k$"],
        ["Régulateurs / TRACFIN", "Capacité d'audit avec preuve crypto", "250 k$+"],
    ],
    [55, 80, 35],
)

h3("Pourquoi : la fenêtre d'opportunité")
bullets([
    "Réglementaire : MiCA entre pleinement en vigueur fin 2026. Les protocoles DeFi opérant en "
    "Europe DEVRONT prouver leur conformité AML.",
    "Économique : une attaque flashloan moyenne coûte 25 M$ au protocole victime. Notre offre "
    "Guard à 30 k$/an = 0,12 % du coût d'un seul incident évité.",
    "Technologique : Cerebras (49 tok/s sur Qwen 235B) rend possible aujourd'hui une "
    "orchestration impensable il y a 18 mois.",
], ordered=True)

h3("Stratégie commerciale : land & expand")
table(
    ["Plan", "Inclus", "Tarif", "Engagement"],
    [
        ["Watch", "WebSocket public, scoring GAT, 50 alertes/jour.", "0 $/mois", "Aucun"],
        ["Guard", "Pipeline complet, 5 000 alertes/jour, sentinel 1 chaîne, SLA 24h.", "2 500 $/mois", "12 mois"],
        ["Defend", "Quotas illimités, 5 chaînes, SLA 2h, manifest persisté, fine-tuning.", "12 000 $/mois", "12-36 mois"],
        ["Enterprise", "On-premise / VPC, audit OFAC, compliance MiCA, formations.", "sur devis", "24-36 mois"],
    ],
    [25, 90, 30, 25],
)
p("Le segment protocoles DeFi est notre point d'entrée prioritaire : sensibilité au risque "
  "maximale, budget sécurité existant (audits Trail of Bits, primes Immunefi), cycle de "
  "décision court (5-15 personnes décisionnaires).")

h3("Go-to-market en trois temps")
bullets([
    "Design partners (mois 0-12) : 3 à 5 protocoles à 60 k$/an, validation produit, témoignages.",
    "Inbound DAO + Forta marketplace (mois 6-18) : plan Watch gratuit pour génération de leads.",
    "Sales enterprise (mois 12+) : équipe AE/SE pour cycles CEX et régulateurs.",
], ordered=True)


# ---------- 8 POURQUOI NOUS ----------
pdf.add_page()
h2("8. Pourquoi nous : crédibilité du projet livré")
p("KOVER.IA n'est pas un slide-deck : le projet livré au Hackathon AI Paris 2026 est "
  "pleinement fonctionnel.")
bullets([
    "Modèles entraînés sur données Ethereum réelles (Salam Ammari), accuracy validation 97 % sur le GAT.",
    "Pipeline orchestré GAT + LSTM + LLM Cerebras, latence bout-en-bout < 5 s.",
    "Sentinel flashloan opérationnel sur le mempool Ethereum, débit 6,5 M ev/s.",
    "Manifest cryptographique exposé publiquement, vérifiable HMAC-SHA256.",
    "Qualité industrielle : GitHub Actions, SonarCloud, 80 tests pytest, couverture 95-100 % sur les modules critiques.",
])
quote("La fenêtre d'opportunité est étroite. MiCA s'applique fin 2026, et les protocoles DeFi "
      "qui n'auront pas adopté un AML traçable et auditable seront mécaniquement exclus des "
      "marchés européens. KOVER.IA se positionne comme l'option native crypto pour répondre à "
      "cette contrainte, là où Chainalysis et Elliptic restent ancrés dans un modèle de "
      "compliance bancaire hérité.")
insight("Synthèse. Nous résolvons un problème réel (blanchiment + flashloans en temps réel), "
        "avec une approche techniquement inédite (triple couche IA + provenance crypto), pour une "
        "cible solvable (protocoles DeFi, CEX, DAO, régulateurs), sur une fenêtre réglementaire "
        "ouverte (MiCA), avec une marge SaaS structurelle (> 93 %) et un produit déjà "
        "fonctionnel et auditable.")


pdf.output("RAPPORT_KOVER_IA_COMPLET.pdf")
print("PDF généré : RAPPORT_KOVER_IA_COMPLET.pdf")
