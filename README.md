# messkit.app

The public page for [Messkit](https://messkit.app), a kitchen inventory app in development by Messkit LLC.

Static HTML, no build step, no cookies, no analytics. Served by GitHub Pages from `main`.

This repository is public because GitHub Pages is free only for public repositories; the app itself lives in the private `messkit-app/messkit` repository. **Nothing secret goes in here** — no keys, no tokens, no unpublished plans, no tester emails.

Editing: change the HTML, commit to `main`, and Pages redeploys. Design tokens are copied from `docs/design/tokens.md` in the app repo; keep them in step by hand.

## Pages

| Path | What | JavaScript |
|---|---|---|
| `/` | the company page | none |
| `/privacy.html`, `/terms.html` | privacy and terms | none |
| `/testing/` | the tester checklist for Messkit Dev testers (messkit-app/messkit#535) | `testing/testing.js` |

## `/testing/`: the tester checklist

A tester invited to Messkit Dev through TestFlight opens `https://messkit.app/testing/`, gives the email they use for TestFlight and the build they are testing, and marks each check they owe Pass, Fail or Couldn't try, with an optional note and screenshot. Not linked from the home page, and `noindex`.

- **Backend:** the `tester-checks` edge function on the **dev** Supabase project. Its contract is in the app repo, `docs/spec/api-contracts.md` → tester-checks; the checks come from `docs/testing/tester-checklist.md` there. Testers are added with `scripts/tester-checklist.sh add-tester` in the app repo.
- **Config:** the `CONFIG` block at the top of `testing/testing.js`: the function URL and the Supabase origin. Both are public. No key is sent: the function runs with `verify_jwt` off.
- **CSP:** a `<meta>` policy in `testing/index.html`. `connect-src` allows only the dev Supabase host (the function and the signed screenshot upload); scripts and styles only from this site. Change the host there and in `CONFIG` together.
- **The email** is kept in `localStorage` on the tester's device and never goes in a URL. A link may carry the build: `https://messkit.app/testing/?build=0.2.14+52`.
- **Screenshots** are shrunk in the browser to 1600 px on the long side, as JPEG, then `PUT` to the signed upload URL the function hands out.
- **Answers** are saved on tap. A check answered on this device for this build stays answered on a reload (the function keeps a failed check owed, so it would otherwise come back); a new build shows it again.

Trying it locally: the function allows the origins `https://messkit.app` and `http://localhost:8000`, so `python3 -m http.server 8000` from the repo root serves it at `http://localhost:8000/testing/`.
