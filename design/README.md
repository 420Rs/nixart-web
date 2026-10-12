Design generated in Google Stitch: https://stitch.withgoogle.com/projects/3278704030655781008

Direction: black background, white type, neutral gray dividers, generous spacing, quiet product grid. The final shop lists digital tools, accounts and services only; courses and course preorders are excluded. Existing product banners retain their original colors. CapCut and OnlyFans each occupy one card with a selectable package, live price, conditions and matching Discord link. Generated sample descriptions, warranties, delivery estimates and placeholder links are replaced with the live shop's public values.

Deployment: the root domain serves index.html on the existing Render service. Live public prices come from the existing Bot-Hosting API /api/storefront. Copy deploy/storefront-handler.js to netlify/functions/storefront-catalog.js on that runtime; its relative import is intentional for the destination. Upload storefront-catalog.js, content/storefront-links.json and assets/shop-banners/*.webp, then run scripts/patch-host-storefront.js from the bot root and restart. The database module stays on the existing bot runtime. No new database or payment flow is required.

Preview: node scripts/preview-storefront.js, then open http://127.0.0.1:4180/. Checks: node --test test/storefront-catalog.test.js test/storefront-groups.test.js.
