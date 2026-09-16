# MedCal on Synology DS224+

This folder contains the self-hosted sync backend for the appointment calendar.

## What runs on the NAS

- `medcal-api`: Node.js API exposed on NAS port `8787`
- `medcal-db`: PostgreSQL 16 database stored under `./data/postgres`

## First setup in DSM

1. Install **Container Manager** from Package Center.
2. Open **File Station** and create `/docker/medcal`.
3. Copy the contents of this `synology` folder into `/docker/medcal`.
4. Copy `.env.example` to `.env`.
5. Edit `.env` and set:
   - a long random `POSTGRES_PASSWORD`
   - a private `PAIRING_CODE` you will enter only when pairing a new device
6. In Container Manager, create a Project using `/docker/medcal/docker-compose.yml`.
7. Build/start the project.

## Test

From another device on the same network, open:

`http://NAS-IP:8787/health`

Expected response:

```json
{"ok":true}
```

## Pair a device

The web app will later call:

`POST http://NAS-IP:8787/api/pair`

with the pairing code once. The API returns a long device token. The device stores that token locally and uses it for all future sync calls, so no username/password is needed for normal use.

## Next step

Once `/health` works, connect the existing calendar UI to this API and add a small one-time **Connect device** screen. After that, appointments and doctors can sync across devices.

## Remote access

Do not expose PostgreSQL directly to the internet. If remote access is needed, expose only the API through HTTPS/reverse proxy or use Tailscale. This can be configured after LAN sync is working.
