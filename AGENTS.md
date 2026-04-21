# AGENTS.md - Règles de contribution agentique

Ce dépôt maintient un **projet embarqué Shelly Script** pour cave à saucissons.

## Portée et principes

- Le cœur exécutable DOIT rester un **script unique** : `src/cave_saucisson.js`.
- Pas d'architecture runtime multi-fichiers.
- Pas de dépendances runtime externes.
- Pas de Node.js/TypeScript/frameworks, sauf justification explicite exceptionnelle validée humainement.
- Respect strict des API officielles Shelly Script.
- KISS obligatoire : simplicité, lisibilité, robustesse, maintenabilité.

## Invariants de sécurité (non négociables)

1. **Le simultané chauffage + froid est interdit sauf en `DRYING_ACTIVE`, où il est autorisé uniquement comme compensation thermique explicite.**
2. Si température air locale indisponible : arrêt actionneurs + publication défaut.
3. Fallback température externe MQTT invalide/périmée -> sonde air locale.
4. Fallback humidité MQTT invalide/périmée -> mode température seule.
5. Le chauffage ne doit jamais être commandé par l'humidité.
6. La sécurité thermique prime toujours sur la régulation fine.

Tout changement qui brise un invariant est interdit.

## Règles d'évolution du code

- Conserver toutes les valeurs configurables regroupées dans `CONFIG`.
- Ajouter des commentaires courts, utiles, orientés exploitation.
- Toute logique importante nouvelle doit être documentée dans :
  - `README.md`
  - `docs/architecture.md`
  - `docs/mqtt-topics.md` si impact MQTT
- Toute décision importante (changement d'état, défaut, fallback, verrouillage) doit rester télémetrisée.

## Processus recommandé pour un agent

Avant modification :
1. Lire `README.md`.
2. Lire `docs/architecture.md` et `docs/commissioning.md`.
3. Lire `src/cave_saucisson.js`.
4. Modifier avec parcimonie (minimal diff utile).
5. Vérifier cohérence docs/code.

## Ce qu'un agent ne doit pas faire

- Transformer le projet en application web/cloud.
- Introduire une stack de build lourde sans besoin démontré.
- Ajouter des fichiers « placeholder » sans valeur opérationnelle.
- Complexifier la logique au détriment de l'exploitabilité terrain.

## Attendu de qualité

- Documentation à jour et actionnable.
- Changements traçables dans `CHANGELOG.md`.
- Commits compréhensibles et ciblés.
