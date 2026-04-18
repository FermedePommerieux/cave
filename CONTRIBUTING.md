# Contribuer

Merci de garder le projet simple et exploitable en environnement embarqué.

## Règles principales

- Prioriser la sécurité physique et thermique.
- Garder le runtime dans un unique script Shelly : `src/cave_saucisson.js`.
- Éviter toute dépendance, build ou framework inutile.
- Respecter KISS : code lisible, explicite, robuste.

## Style de code

- JavaScript Shelly Script, sans API Node.js.
- Variables de configuration regroupées dans `CONFIG`.
- Commentaires brefs et utiles uniquement.
- Noms explicites (éviter les abréviations ambiguës).

## Politique de commentaires

- Expliquer le *pourquoi* des garde-fous, pas l'évidence syntaxique.
- Documenter chaque mode dégradé/fallback.

## Politique de commit

- Commit atomique et ciblé.
- Message impératif et clair.
- Mettre à jour `CHANGELOG.md` pour toute évolution notable.

## Vérifications minimales avant PR

- Cohérence entre `README`, `docs/*` et script.
- Invariant préservé : jamais chauffage + froid simultanés.
- Modes fallback MQTT/capteurs toujours présents.
