# TMDB live answers (trimmed)

Real answers from TMDB, fetched once on 2026-11-09 through the owner's key
(PLAN.md 8.2) and cut down to the fields the client reads. They show the true
shape of each call the client makes; hand-written test data should follow them.

- `configuration.json`: `/configuration` (picture address and sizes)
- `genre-movie-list.json`, `genre-tv-list.json`: every genre id; the table in
  `tmdb-mapping.ts` knows all of them and no others
- `search-movie-green-book-2018.json`: `/search/movie?query=Green Book&year=2018`
- `movie-490132-green-book.json`:
  `/movie/490132?append_to_response=credits,release_dates` (first 12 cast, the
  director, the US release dates)
- `search-tv-stranger-things.json`: `/search/tv?query=Stranger Things` (first 5)
- `tv-66732-stranger-things.json`:
  `/tv/66732?append_to_response=aggregate_credits` (first 12 cast)

No key, address or header is stored here.
