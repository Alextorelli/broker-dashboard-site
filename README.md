# The Anton Group dashboards: published pages

Static page code only. The pages hold no data and no credentials: figures load from a database after sign-in, and
only approved emails get any. Both pages share one sign-in.

| Page | Path | Source repo (private) |
| --- | --- | --- |
| Broker Market Dashboard | `/` | broker-submarket-data, `frontend/` |
| Digital Presence | `/digital-presence/` | anton-group-marketing-data, `site/` |

Live at https://alextorelli.github.io/tag-dashboard-demos/ (this repo was formerly `broker-dashboard-site`;
the old `broker-dashboard-site` addresses no longer work).

Change a page in its source repo, not here, then copy it in with a "Publish" commit.

If this repo is renamed or transferred, both pages move to a new address. Before a transfer, add the new owner's
`github.io` domain to Neon Auth's trusted domains in the Market Data project, or sign-in stops working.
