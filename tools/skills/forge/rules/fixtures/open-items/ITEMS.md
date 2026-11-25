# Open items (round 4)

Unchecked, all to be finished here:

- **03. Cart total wrong with a discount.** Owner: "the total ignores the discount". Code in `src/cart/`, test `test/cart.test.js` is red.
- **07. Org 107 shows no patient details.** Owner: "PHI is missing on 107". Check it live: `node live.mjs phi` drives the one browser (about 20 s; the browser takes one check at a time) and prints what the page shows.
- **09. Delivery range drops the last day.** Owner: "a 3-day range shows 2 days". Code in `src/dates/`, test `test/dates.test.js` is red.
- **20. Product URLs keep accents.** Owner: "café gives a broken link". Code in `src/text/`, test `test/text.test.js` is red.

Tests: `npm test`. Do not change the tests.
