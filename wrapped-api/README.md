# Onchain Wrapped API

Cloudflare Worker behind apurvacrypto.xyz/wrapped. It handles:

- X link previews: each shared link shows that person's card
- The opt-in leaderboard, checked against Hyperliquid's own data
- A Polymarket proxy, used only if Polymarket blocks direct requests from the site

The site works without it. These features stay hidden until the Worker URL is set.

## Deploy (about 5 minutes, free plan)

```bash
cd wrapped-api
npx wrangler login                                   # opens Cloudflare in your browser
npx wrangler kv namespace create KV                  # prints an id
# paste that id into wrangler.toml in place of REPLACE_WITH_KV_ID
npx wrangler deploy                                  # prints https://onchain-wrapped-api.<you>.workers.dev
```

Then open `wrapped/index.html` and set:

```js
const API = "https://onchain-wrapped-api.<you>.workers.dev";
```

Commit and push. GitHub Pages picks it up in about a minute.

## Notes

- Free-tier KV allows 1,000 writes a day. Each share or leaderboard join is one write. If it goes viral, the $5/month Workers plan raises that limit.
- Share images expire after 180 days.
- Only requests from `ALLOWED_ORIGINS` in wrangler.toml can upload images or join the leaderboard.
