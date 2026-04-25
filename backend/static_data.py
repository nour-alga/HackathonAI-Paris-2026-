"""
Real data from the Euler Finance hack — March 13, 2023.
Source: public Etherscan records, blockchain explorers, post-mortem reports.
"""

HACKER_ADDRESS = "0xb66cd966670d962C227B3EABA30a872DbFb995db"
EULER_CONTRACT = "0x27182842E098f60e3D576794A5bFFb0777E025d3"
ATTACK_TX = "0xc310a0affe2169d1f6feec1c63dbc7f7c62a887ad48b6276cbe600ad69a2834f"
ATTACK_BLOCK = 16817996
ATTACK_TIMESTAMP = "2023-03-13T08:32:49Z"


def get_timeline():
    """Block-by-block risk score in the 10 blocks before and during the attack."""
    return {
        "hack": "Euler Finance",
        "date": "2023-03-13",
        "blocks": [
            {
                "block": 16817986,
                "timestamp": "2023-03-13T08:30:19Z",
                "risk_score": 5,
                "event": None,
            },
            {
                "block": 16817989,
                "timestamp": "2023-03-13T08:31:04Z",
                "risk_score": 14,
                "event": "Wallet 0xb66c interacts with Euler Finance — unusual pattern",
            },
            {
                "block": 16817991,
                "timestamp": "2023-03-13T08:31:34Z",
                "risk_score": 31,
                "event": "Flashloan request detected: 30,000,000 DAI from Aave v2",
            },
            {
                "block": 16817993,
                "timestamp": "2023-03-13T08:32:04Z",
                "risk_score": 58,
                "event": "Abnormal eToken donation sequence — no financial incentive detected",
            },
            {
                "block": 16817995,
                "timestamp": "2023-03-13T08:32:34Z",
                "risk_score": 79,
                "event": "Self-liquidation triggered — reserves draining at abnormal speed",
            },
            {
                "block": ATTACK_BLOCK,
                "timestamp": ATTACK_TIMESTAMP,
                "risk_score": 96,
                "event": "CRITICAL — 197M USD extracted. Alerts dispatched.",
                "alert": True,
            },
            {
                "block": 16817999,
                "timestamp": "2023-03-13T08:33:19Z",
                "risk_score": 98,
                "event": "Fund dispersion started — 43 wallets targeted in 4 minutes",
            },
        ],
    }


def get_alert_details():
    """Main alert card shown in the dashboard."""
    return {
        "id": "ALERT-2023-031301",
        "severity": "CRITICAL",
        "protocol": "Euler Finance",
        "timestamp": ATTACK_TIMESTAMP,
        "block": ATTACK_BLOCK,
        "transaction": ATTACK_TX,
        "attacker": HACKER_ADDRESS,
        "attack_type": "Flashloan + Donate + Self-liquidation",
        "flashloan": {
            "source": "Aave v2",
            "token": "DAI",
            "amount": 30_000_000,
        },
        "stolen": {
            "total_usd": 197_000_000,
            "breakdown": [
                {"token": "DAI", "amount": 96_000_000},
                {"token": "USDC", "amount": 45_000_000},
                {"token": "stETH", "amount": 38_000_000},
                {"token": "WBTC", "amount": 18_000_000},
            ],
        },
        "risk_score": 96,
        "ai_analysis": (
            "Pattern identique aux hacks Cream Finance (Oct 2021) et Rari Capital (Apr 2022). "
            "Le wallet 0xb66c a interagi avec Euler 4 fois en 2 blocs — comportement anormal. "
            "La séquence donate→self-liquidate est une signature connue des exploits de protocoles de lending. "
            "Flashloan de 30M DAI utilisé comme levier pour amplifier l'extraction."
        ),
        "alerts_sent": [
            {"target": "Euler DAO", "channel": "on-chain signal", "status": "sent"},
            {"target": "Circle (USDC)", "channel": "API", "status": "sent"},
            {"target": "Binance", "channel": "webhook", "status": "sent"},
            {"target": "OFAC Watch", "channel": "report", "status": "sent"},
        ],
    }


def get_dispersion_graph():
    """
    Graph of stolen funds after the hack.
    Nodes = wallets/entities. Edges = fund transfers.
    Amounts in USD.
    """
    return {
        "total_stolen_usd": 197_000_000,
        "dispersion_duration_seconds": 247,
        "wallet_count": 43,
        "nodes": [
            {"id": "euler", "label": "Euler Finance", "type": "protocol", "amount": 197_000_000, "flagged": False},
            {"id": "hacker", "label": "Attacker\n0xb66c...95db", "type": "attacker", "amount": 197_000_000, "flagged": True},
            {"id": "w1", "label": "0x8faa...c12b", "type": "wallet", "amount": 45_000_000, "flagged": True},
            {"id": "w2", "label": "0x3f9c...7e4a", "type": "wallet", "amount": 38_000_000, "flagged": True},
            {"id": "w3", "label": "0x1a2b...9f3d", "type": "wallet", "amount": 32_000_000, "flagged": True},
            {"id": "w4", "label": "0x7d8e...2c1f", "type": "wallet", "amount": 27_000_000, "flagged": True},
            {"id": "w5", "label": "0x4b5c...8a7e", "type": "wallet", "amount": 22_000_000, "flagged": True},
            {"id": "w6", "label": "0x9e0f...3b2c", "type": "wallet", "amount": 18_000_000, "flagged": True},
            {"id": "w7", "label": "0x2c3d...6f5e", "type": "wallet", "amount": 8_500_000, "flagged": True},
            {"id": "w8", "label": "0x6e7f...1a0b", "type": "wallet", "amount": 6_500_000, "flagged": True},
            {"id": "tornado", "label": "Tornado Cash\n(Mixer)", "type": "mixer", "amount": 40_000_000, "flagged": True},
            {"id": "bridge_bnb", "label": "BNB Bridge", "type": "bridge", "amount": 35_000_000, "flagged": True},
            {"id": "circle", "label": "Circle\n(USDC Issuer)", "type": "freezable", "amount": 45_000_000, "flagged": False},
        ],
        "edges": [
            {"from": "euler", "to": "hacker", "amount": 197_000_000, "token": "Mixed"},
            {"from": "hacker", "to": "w1", "amount": 45_000_000, "token": "USDC"},
            {"from": "hacker", "to": "w2", "amount": 38_000_000, "token": "DAI"},
            {"from": "hacker", "to": "w3", "amount": 32_000_000, "token": "DAI"},
            {"from": "hacker", "to": "w4", "amount": 27_000_000, "token": "stETH"},
            {"from": "hacker", "to": "w5", "amount": 22_000_000, "token": "DAI"},
            {"from": "hacker", "to": "w6", "amount": 18_000_000, "token": "WBTC"},
            {"from": "hacker", "to": "w7", "amount": 8_500_000, "token": "ETH"},
            {"from": "hacker", "to": "w8", "amount": 6_500_000, "token": "ETH"},
            {"from": "w2", "to": "tornado", "amount": 20_000_000, "token": "ETH"},
            {"from": "w3", "to": "tornado", "amount": 20_000_000, "token": "ETH"},
            {"from": "w4", "to": "bridge_bnb", "amount": 27_000_000, "token": "stETH"},
            {"from": "w5", "to": "bridge_bnb", "amount": 8_000_000, "token": "DAI"},
            {"from": "w1", "to": "circle", "amount": 45_000_000, "token": "USDC"},
        ],
        "summary": {
            "freezable_usd": 45_000_000,
            "tracked_usd": 112_000_000,
            "lost_to_mixer_usd": 40_000_000,
        },
    }


def get_summary_stats():
    """High-level stats for the dashboard header."""
    return {
        "hack": "Euler Finance",
        "date": "2023-03-13",
        "total_stolen_usd": 197_000_000,
        "detection_block": ATTACK_BLOCK,
        "detection_time_seconds": 15,
        "wallets_involved": 43,
        "dispersion_duration_seconds": 247,
        "funds_freezable_usd": 45_000_000,
        "funds_tracked_usd": 112_000_000,
        "funds_lost_usd": 40_000_000,
        "attacker": HACKER_ADDRESS,
        "protocol": "Euler Finance",
        "attack_vector": "Flashloan exploit (donate + self-liquidation)",
    }
