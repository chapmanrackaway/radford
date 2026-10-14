# Radford Rides to Vote

An interactive map that helps Radford, Virginia voters find a Radford Transit bus from home to their polling place. It's modeled on [Transit to Turnout](https://transittoturnout.org/) in Charlottesville.

## How it works for voters

1. **Where do you live?** Enter the home address from your voter registration, use your phone's location, or tap the map.
2. **Where do you vote?** Pick your precinct from the list (it's printed on your voter card). If you add a precinct boundary layer (see below), the site also suggests a precinct from your address and asks you to confirm it. A link goes to the state's voter lookup for anyone who isn't sure. The early-voting office appears in the list until early voting ends.
3. **When do you want to leave?** Choose a departure time during polling hours.

The site then shows:

- up to three bus itineraries (one bus or one transfer), each with walking steps, departure and arrival times, and the route drawn on the map
- a **Plan my trip home** button for the return trip
- the bus routes near your home and near your polling place
- a note when walking would be quicker, and a warning when a trip arrives after polls close
- a Google Maps transit link to compare against

Trip planning runs entirely in the browser. The address search goes to OpenStreetMap's Nominatim geocoder, and nothing is stored.

## Project layout

```
config/site.json           Election date, poll hours, early voting, data URLs, links
data/polling-places.json   The 4 Radford City polling places (edit this when locations change)
scripts/build-data.mjs     Builds site/data/ from live sources
scripts/lib/gtfs.mjs       Turns the GTFS feed into a compact Election Day schedule
site/                      The static website (deployed as-is)
site/js/router.js          The trip planner (a small RAPTOR search over the schedule)
site/js/app.js             Map, form, and results UI
test/                      Unit tests with a small made-up GTFS fixture
```

## Data sources

| Data | Source | When it's fetched |
|---|---|---|
| Bus routes, stops, schedules | Radford Transit GTFS feed from Trillium (`https://data.trilliumtransit.com/gtfs/radford-va-us/radford-va-us.zip`), with the [MobilityDatabase](https://mobilitydatabase.org/) mirror as a fallback | At build time |
| Polling places | City of Radford elections office (see `source` in `data/polling-places.json`) | Edited by hand |
| Polling-place coordinates | US Census geocoder, with Nominatim as a fallback | At build time |
| Precinct boundaries (optional) | None configured yet. Add `precinctBoundaries.url` (a GeoJSON query) to `config/site.json` to turn on precinct suggestions | At build time |
| Address search, map tiles | OpenStreetMap | In the visitor's browser |

The schedule is built for Election Day (`election.date` in `config/site.json`). If Radford Transit's feed doesn't cover that date yet, the build uses the nearest date in the feed that falls on the same weekday, and the site shows a banner saying so.

Precinct boundaries are only used to suggest a precinct. A polygon is kept only if its name matches a current precinct in `data/polling-places.json`, so an outdated layer can fail to suggest a precinct but can't suggest one that no longer exists. If the layer can't be fetched, voters just pick their precinct from the list.

## Running it locally

Requires Node 20 or newer and internet access.

```sh
npm install
npm run build        # copies Leaflet into site/vendor and builds site/data/
npm run serve        # http://localhost:8080
npm test
```

To build from a GTFS file you already have, run `node scripts/build-data.mjs --gtfs path/to/feed.zip`. The flags `--skip-geocode` and `--skip-precincts` skip those steps.

## Deploying (GitHub Pages)

`.github/workflows/deploy.yml` runs the tests, builds the data, and publishes `site/` to GitHub Pages. It runs on every push to `main`, every morning (to pick up schedule changes), and on demand. To turn it on:

1. Go to **Settings → Pages** in the repository.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Push to `main`, or start the workflow from the **Actions** tab.

If a source is down during a build, the build fails and the previously deployed site stays up.

## Updating for a new election

1. Update `election` (and `earlyVoting`) in `config/site.json`.
2. Check `data/polling-places.json` against the city's polling place page and update the `checked` date.
3. If the geocoder puts a polling place in the wrong spot, add `"lat"` and `"lon"` to that entry. The build keeps coordinates you set by hand.
4. Push. The workflow rebuilds the schedule for the new date.

## Before Election Day

Three of the four polling-place addresses in `data/polling-places.json` come from a single non-official source. Confirm all four with the Radford City Office of Elections, (540) 731-3639, and update the `checked` date. State election records have called the West Central precinct "Central".

## Disclaimer

This is an independent, nonpartisan tool. It isn't run by the City of Radford, the Virginia Department of Elections, or Radford Transit. Voters should confirm their polling place with official sources.
