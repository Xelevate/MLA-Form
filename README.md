# MLA Transfer · Intake

Browser-only tool for processing customer transfer details. Drops into GitHub Pages as a static site.

## What it does

Employee pastes unstructured customer text. The tool:

1. **Parses** it into structured fields (phone, name, address, card, etc.)
1. **Checks the phone against the DNC sheet** (live fetch from Google Sheets)
1. **Validates the card format** locally with the Luhn algorithm + brand detection (same math as stevemorse.org/ssn/cc.html, just instant and private)
1. **Confirms all required fields are present**
1. Opens a **pre-filled Google Form** in a new tab so the ops manager only has to review and click Submit. Center is auto-set to **XV**.

If any check fails, the “Open form” button is disabled.

## Deploy in 4 steps

1. **Fork or clone** this repo, push to your own GitHub.
1. **Configure form IDs once** — open `setup.html` (locally or after deploy), follow the bookmarklet or page-source method, copy the generated config, and paste it into `config.js`. Commit.
1. **Enable Pages**: repo → Settings → Pages → Source: `main` branch / root → Save.
1. Visit `https://<yourusername>.github.io/<reponame>/` and share the link with employees.

## Files

|File        |What it is                                        |
|------------|--------------------------------------------------|
|`index.html`|The main employee tool                            |
|`app.js`    |Parsing, DNC check, Luhn, form-URL builder        |
|`config.js` |Form field IDs (you fill in once via `setup.html`)|
|`setup.html`|One-time form-ID extraction helper                |
|`README.md` |This file                                         |

## Privacy

All parsing, card validation, and form-URL building happens in the browser. The only network call is to fetch the DNC sheet (a one-time read of a public Google Sheet). No card data, name, or phone is sent to any server.

## DNC sheet

The tool fetches: `https://docs.google.com/spreadsheets/d/1tftqIjhDt7PLWPMT6OuXZU3Et2a-KGMNbKu7l7oRdSU/gviz/tq?tqx=out:csv&gid=0`

This works as long as the sheet’s sharing is “Anyone with the link can view.” If the owner changes that, the DNC check will silently fail (the UI shows a yellow warning, doesn’t block).

To point at a different sheet, edit `DNC_SHEET_URL` at the top of `app.js`.

## Card check

Cards are validated with the **Luhn algorithm** and brand regexes for Visa / Mastercard / Amex / Discover / Diners / JCB. The form is blocked unless: card passes Luhn AND brand recognised AND expiration date is in the future.

This is the exact validation stevemorse.org runs — but instant and without leaving the page.

## Notes / known limits

- The pre-filled URL approach **opens** the form in a new tab; the operations manager still clicks Submit themselves (by design).
- Some unusual address formats (PO boxes, rural routes, two-line addresses) may parse partially. The parsed-fields panel is editable inline — just click any value to fix it.
- The DNC sheet is read on first parse and cached for the rest of the session. Reload the page to pick up new DNC additions.