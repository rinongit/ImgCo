# MedCal Google Sheets sync

This folder contains the Google Apps Script backend used by the appointment calendar.

Spreadsheet: `Medical Center - MedCal Database`

Spreadsheet ID: `1VV5aDO7UmyzMYdGDgP3D3emQdxJ_XcM-eeq6PXrwgSs`

## Deploy

1. Open the spreadsheet in Google Sheets.
2. Open **Extensions → Apps Script**.
3. Replace the contents of `Code.gs` with the contents of this repository's `google-apps-script/Code.gs`.
4. Click **Save**.
5. Run the `setup` function once and approve Google's authorization prompts.
6. Click **Deploy → New deployment → Web app**.
7. Set **Execute as: Me**.
8. Set **Who has access: Anyone**.
9. Deploy and copy the URL ending in `/exec`.

The MedCal frontend will use that URL to sync appointments and doctors. Devices pair once using the private pairing code stored in the spreadsheet's `Meta` sheet. Device tokens are stored hashed in the `Devices` sheet.

The API supports `pair`, `state`, `mergeLocal`, `saveAppointment`, `deleteAppointment`, `replaceDoctors`, and `disconnect` actions.
