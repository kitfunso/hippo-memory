### Performance

- Drill-down reads whole rows only for the page it returns and counts the rest in SQL, the drill route refuses a `limit` above 1000 as the other list routes do, and the dashboard snapshot reads only the columns it shows.
