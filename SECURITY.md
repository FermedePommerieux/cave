# Security Policy

## Signaler une vulnérabilité

Merci d'ouvrir une issue privée si possible (ou contacter le mainteneur hors canal public) avec :

- contexte matériel
- version du script
- scénario de reproduction
- impact observé

Ne publiez pas publiquement de détails exploitables avant correction.

## Risques spécifiques

Ce projet pilote un système thermique réel.

- Une mauvaise configuration peut entraîner surchauffe, gel, dégradation produit, ou dommage matériel.
- Toujours conserver des sécurités matérielles indépendantes (protections électriques, thermostat de sécurité, disjoncteurs adaptés).
- Tester en environnement supervisé avant production.

## Bonnes pratiques d'exploitation

- Vérifier périodiquement capteurs et relais.
- Surveiller les topics de défaut MQTT.
- Journaliser les modifications de paramètres.
