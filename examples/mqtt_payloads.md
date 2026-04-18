# Exemples MQTT

## Publication température externe

Topic:

`fdp_communs_cave_saucissons/thermostat/external_temperature`

Payload:

```text
12.6
```

## Publication humidité externe

Topic:

`fdp_communs_cave_saucissons/thermostat/external_humidity`

Payload:

```text
79.2
```

## Injection défaut (payload invalide)

Topic:

`fdp_communs_cave_saucissons/thermostat/external_humidity`

Payload:

```text
NaN
```

Comportement attendu : passage en mode température seule après expiration `humidityStaleS`.
