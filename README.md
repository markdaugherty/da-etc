# da-etc

A small Cloudflare Worker that hosts a handful of miscellaneous HTTP endpoints
used by Adobe Document Authoring (DA) / AEM Edge Delivery tooling: a CORS
proxy, an AI-powered tag extractor, and translation-integration login
endpoints (Trados, Lionbridge, Smartling, GlobalLink).

## Endpoints

### `GET /cors`, `POST /cors` (also `PUT`, `DELETE`, `HEAD`)

Generic CORS-unblocking proxy. Fetches `url` on the caller's behalf and
returns the response with permissive CORS headers attached.

```
GET /cors?url=<encoded target URL>
```

Request headers (minus `host`/`origin`) and body are forwarded to the target.
`HEAD` requests follow redirects manually rather than letting `fetch` do so
automatically.

### `POST /tags`

Extracts 5–10 keyword tags from an HTML fragment using OpenAI.

```json
// Request body
{ "html": "<p>...</p>" }
```

The HTML is stripped of `<script>`/`<style>` tags and markup, decoded, and
sent to `gpt-5-nano` with a JSON-schema-constrained response. Returns:

```json
{ "tags": ["tag1", "tag2", "..."] }
```

Requires the `OPENAI_API_KEY` binding/secret.

### `POST /:org/config/:site/integrations/:service/:action`

Server-side integration helper. Currently supports `login` for four services:

```
POST /:org/config/:site/integrations/trados/login?env=prod
POST /:org/config/:site/integrations/lionbridge/login?env=prod
POST /:org/config/:site/integrations/smartling/login?env=prod
POST /:org/config/:site/integrations/globallink/login?env=prod
```

Given an `Authorization` header for the DA admin API, this:
1. Fetches the site's translation service config from
   `https://admin.da.live/source/:org/:site/.da/translate.json`.
2. Optionally fetches a service key document referenced by that config.
3. Exchanges the resolved client credentials for a token, using the token
   fetcher for the requested service (`TOKEN_FETCHERS` in
   `src/routes/ints.js`). Trados and Lionbridge use an OAuth2
   `client_credentials` grant; Smartling exchanges a `userIdentifier`/
   `userSecret` pair via its own `auth-api/v2/authenticate` endpoint; 
   GlobalLink uses a resource-owner `password` grant (client
   id/secret via Basic auth, plus a per-user username/password resolved
   from the same config).

Returns the token response, or an error/status code if any upstream
step fails. This keeps the credentials out of the browser entirely — 
the client only ever calls this endpoint with its own DA session auth, 
never the third-party service's credentials.

## Architecture

```
src/
  index.js            Worker entrypoint — dispatches by HTTP method
  handlers/
    get.js            GET/HEAD dispatch → /cors
    post.js           POST/PUT/DELETE dispatch → /cors, /tags, /:org/.../integrations
    options.js        CORS preflight (checks Origin against ALLOWED_DOMAINS)
  routes/
    cors.js           CORS proxy implementation
    tags.js           Tag extraction route
    ints.js           Third-party integration routes (Trados, Lionbridge, Smartling, GlobalLink)
  utils/
    constants.js      Default response headers, allowed CORS origins
    html.js           HTML → plain text cleanup
    openai.js         OpenAI chat completion call for tag extraction
```

Unhandled routes return `null`, which Cloudflare turns into an empty 200
response; unknown HTTP methods return `405`.

## Development

```bash
npm install
npm run dev          # wrangler dev — local development server
```

### Deploying

```bash
npm run deploy:prod   # wrangler deploy
```

### Linting

```bash
npx eslint .
```

## Configuration

Defined in `wrangler.toml`. The worker expects the following secret to be
configured (e.g. via `wrangler secret put`):

- `OPENAI_API_KEY` — used by the `/tags` endpoint.

Allowed CORS origins for preflight requests are configured in
`src/utils/constants.js` (`ALLOWED_DOMAINS`): `da.live`, `da.page`,
`aem.page`, `aem.live`, `localhost`.

## License

Apache-2.0
