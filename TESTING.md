# Tests + SonarCloud — KOVER.IA

## Lancer les tests en local

```bash
# Depuis la racine du repo, avec le venv déjà setup
.venv-train/Scripts/python -m pytest
```

Cela génère :
- `coverage.xml` — format Cobertura, lu par SonarCloud
- `htmlcov/index.html` — rapport interactif à ouvrir dans le navigateur

### Coverage actuel (39 tests, 7.8s)

| Module | Coverage | Stmts | Notes |
|---|---|---|---|
| `backend/streaming/proof.py` | **89%** | 80 | Manifest signé HMAC, SHA256, log d'inférences |
| `backend/pipeline.py` | **70%** | 86 | `run_pipeline_from_graph` (agents mockés) |
| `backend/streaming/generator.py` | **56%** | 287 | Topologie tier, `_gen_tx`, `_add_tx_to_graph`, lifecycle |
| `backend/storage/models.py` | **100%** | 18 | Pydantic |

**Exclus du calcul Sonar** (intégrations optionnelles ou wiring FastAPI) :
- `backend/main.py` (routes FastAPI — testées implicitement par le runtime)
- `backend/agents/*` (path_agent, reporter_agent — dépendent de torch/Cerebras)
- `backend/storage/bigquery_client.py` (mode no-op si BigQuery indispo)
- `backend/models/path_lstm.py` (modèle PyTorch — chargé au runtime, pas en CI)

## Activer SonarCloud (5 minutes)

1. Aller sur **https://sonarcloud.io** et se connecter avec GitHub.
2. **+ → Analyze new project** → sélectionner `nour-alga/HackathonAI-Paris-2026-`.
3. Choisir **With GitHub Actions** comme méthode d'analyse → Sonar affiche un `SONAR_TOKEN`.
4. Sur GitHub : repo → **Settings → Secrets and variables → Actions → New repository secret** :
   - Name : `SONAR_TOKEN`
   - Value : (le token Sonar)
5. Vérifier que `sonar-project.properties` correspond aux valeurs assignées par Sonar :
   - `sonar.organization=nour-alga`
   - `sonar.projectKey=nour-alga_HackathonAI-Paris-2026-`
   (À ajuster si Sonar a généré une clé différente.)
6. Push n'importe quelle branche `main`, `feat/**`, `demo/**` → le workflow `.github/workflows/sonarcloud.yml` :
   - installe les deps Python lite
   - lance `pytest` → produit `coverage.xml`
   - exécute `sonar-scanner` qui upload l'analyse à SonarCloud

## Quality Gate

SonarCloud applique sa Quality Gate par défaut :
- ≥ 80% coverage sur le **nouveau code**
- 0 vulnérabilités critiques
- < 3% code dupliqué
- Maintainability Rating A

Le badge à mettre dans le README une fois le 1er run terminé :
```markdown
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=nour-alga_HackathonAI-Paris-2026-&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=nour-alga_HackathonAI-Paris-2026-)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=nour-alga_HackathonAI-Paris-2026-&metric=coverage)](https://sonarcloud.io/summary/new_code?id=nour-alga_HackathonAI-Paris-2026-)
```

## TDD workflow

Pour ajouter une nouvelle feature en TDD :

```bash
# 1. Écrire un test qui échoue
echo "def test_my_feature(): assert my_feature() == 42" >> tests/test_my_feature.py
.venv-train/Scripts/python -m pytest tests/test_my_feature.py  # rouge

# 2. Implémenter le minimum pour passer
# ... edit backend/...

# 3. Re-run
.venv-train/Scripts/python -m pytest tests/test_my_feature.py  # vert

# 4. Refactor avec confiance, re-run pour vérifier
.venv-train/Scripts/python -m pytest
```
