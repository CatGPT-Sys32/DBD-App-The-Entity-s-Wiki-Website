# Codex Redesign — Feature Contract

> This file is the binding contract for the `redesign/codex-v6` rebuild.
> Source: exhaustive audit of `web/index.html` (15,060 lines) completed before any UI work.
> Rule: **no feature may be removed or silently altered.** If a conflict appears mid-build,
> stop and resolve against this document.

## Views (renderContent switch — every `setView` literal needs a matching case)

| View | Component | Key behaviors that MUST survive |
|---|---|---|
| home | HomeView | smart search (deferred) with prefixes `killers: survivors: perks: builds: maps: items: addons: offerings: glossary: icons: challenges: chapter: legendary: cosmetics:` + `random:killer/offering/<name>/<type>`; scoring incl. rarity aliases, "Best Match" badge; top 50; per-category deep links; stat cards; tiles (import opens modal); quick chaos/worldle/favorites; pull-to-refresh |
| killers / survivors | ListView | search, sort (name/realname/release via RELEASE_DATE_MAP), favorites (favoriteKillers/Survivors), profile modal on tap, owned-only filter, `?profileId=` deep link |
| perks | ListView (perk mode) | 13 filter chips (All/Survivor/Killer/Favorites/Exhaustion/Hex/Boon/Scourge/Obsession/Aura/Stealth/Gen/Healing — heuristics), perkSearch+perkFilter persistence, long-press 500ms compare (max 4) + FloatingCompareBadge + PerkCompareModal, BottomSheet w/ synergies + notes, dual description mode (legacy/post95 + % highlighting), favorites |
| items | ItemsView | modes Survivor Items / Killer Addons, search incl. addon names, type filter, rarity sort, expandable compatible/power addons, favorites, target-highlight deep link (`data-smoke-target` + scroll), owned-only |
| offerings | OfferingsView | role chips + Secret toggle + rarity sort, search, favorites, target deep link |
| realms | RealmsView | search, realm grouping, MapLayoutModal w/ variation tabs + notes |
| buildLab (+ alias builds) | BuildPlannerView + BuildForm | full form (name required, role toggle resets, character picker, 4 perks, item→addon cascade, offering, tags, notes), edit/duplicate/share(clipboard)/favorite/delete(confirm), filters (role/search/tag/include/exclude perk), PREMADE_BUILDS templates (showTemplates), buildSeed from import/search, encode/decode v1+v2 byte-compatible |
| roulette | ChaosShuffleView | role toggle, randomize checkboxes (item→addons cascade), playing-as lock, owned pool panel (All/None/search), 800ms spin, shake-to-roll (devicemotion, iOS permission), share chaos build |
| worldle | WorldleView | 5 modes × daily/practice, classic 6-field clues, emoji reveal (variant persistence), perk blur stages, teachables, Levenshtein suggestions, stats+streaks (lastDailyDateKey), histograms, history ≤30, deterministic daily, compact layout ≤640 |
| progression | ProgressionView | 4 reorderable tabs (achievements/roster/challenges/analytics), 295 achievements w/ search/sort/hide-completed/toggle, roster ownership+prestige (+teachable coverage), challenges CRUD+status, MatchAnalyticsPanel filters+win-rate boards (killerWinThreshold) |
| matches | MatchLogView | full form (role/character/build/map/outcome/kills/dc/perf/sweat/tilt/hooks/gens/notes), snapshots, prefs persistence (lastRole/lastCharacterId/lastBuildId), history filters + win definition, edit/delete(confirm) |
| cosmetics | CosmeticsView | search, role+character filters, rarity bucket grouping + counts, 120 windowing + Show more, eager-16, focused cosmetic (data-smoke-target), asset-pack banner (Android), favorites via profile |
| gameIcons | GameIconsView | Glossary mode (expandable) + Trial Grid mode (FlashcardModal w/ tips), 6 filters, search, 62 icons |
| glossary | GlossaryView | 15 sections/~159 terms, search, A–Z grouping + sticky headers + letter rail |
| timeline | TimelineView | 52 releases, search, year pills, expand (description + character rows + fog entries + full-profile sheet + maps) |
| favorites | FavoritesView | 7 tabs w/ counts, per-type cards w/ view/remove, empty state |
| prestige | PrestigeCalculatorView | all inputs (prestige/level/target/mode/BP per match/match length), animated output, milestones, no storage |
| settings | SettingsView | see Storage contract; exact string "Website preferences" |
| communityContent (alias quotes) | CommunityContentView | tierlists w/ patch+age labels, builds (empty state), characterInfo, beginnerGuides, guideVault, links; **route alias 'quotes' must keep its case** |
| default | HomeView | |

## Modals (none may be deleted)
CharacterProfileModal (data-smoke-profile, tabs Overview/Power/Perks/Lore, cosmetics section w/ cosmeticFocusId, killer notes, release date from TIMELINE_DATA) · BottomSheet (perk) · PerkCompareModal · LoreModal · PowerModal (tips tabs) · MapLayoutModal (variation tabs, notes, missing-image fallback) · Import Build modal (preview + warnings + save seeds Build Lab) · FlashcardModal · Timeline character sheet · backup restore confirm · delete confirms.

## Storage contract (keys unchanged)
`dbd_builds_v1`, `dbd_matches_v1`, `dbd_progression_v1` (+ legacy `dbd_achievements_progress` merged then deleted), `dbd_settings_v1` (DEFAULT_SETTINGS incl. settingsVersion:2, themePreference:'manual', manualTheme:'ghost', colorMode:'oled', perkDescriptionMode:'post95', showTemplates, rarityGlows, hapticEnabled, ownedOnlyGlobal, googlePlayCtaHidden, progressionTabOrder, navItemsCustomized, navItems, homeTiles, favoritePerks/Killers/Survivors/Items/Addons/Offerings), `dbd_notes_v1` (`perk:|map:|killer:<id>`), `dbd_last_context_v1` (+killerWinThreshold), `dbd_worldle_v1` (sessions/stats/history + lastDailyDateKey + emoji variant persistence), `dbd_ui_state_v1` (view/context/perkFilter/perkSearch).

## Theme engine
12 themes (blood/abyss/midnight/ember/void/rose/ghost accent-only + nord/catppuccin/tokyonight/everforest/rosepinemoon full-palette) × color modes dark/oled/light + fontSize small/default/large. Runtime writes ~30 `--*` CSS custom properties + body classes `light-mode`/`oled-mode`/`full-palette-mode`. **Codex = restyled OLED default; all themes keep working.**

## Image pipeline
`toLocalImageSource` order: cosmetics asset pack (Android, `window.__cosmeticsFullSetPackBaseUrl` + convertFileSrc + revision cache) → `DBD_IMAGE_BASE_URL` → `./`. AssetFrame fallback chain + defaults. First-16 preload (saveData aware). **No raw `<img src>` for dbd_images.**

## Verification constraints (must stay green)
1. No external `<script src>`/`<link href>` (except canonical link)/`<img src>`/CSS `url(http…)` in index.html; no `fonts.googleapis.com|gstatic|unpkg|cdn.tailwindcss.com`, no `fetch(`/`XMLHttpRequest`/`axios`/`CapacitorHttp`/`serviceWorker.register(`, no legacy resolver consts.
2. Route audit: every `setView('x')` needs `case 'x'`; keep `'quotes'` alias case.
3. Script tags: `<script src="cosmetics.js"></script>` + `<script src="community-content.js"></script>` exact; required vendor/data/default files exist.
4. `KILLER_STATS` literal shape `name: { terrorRadius: "...", speed: "...", height: "..."` must match 44/44 killers.
5. Smoke hooks: `data-smoke-ready` + `data-smoke-view` on shell; `data-smoke-target="true"` (items ×4 contexts, offerings, focused cosmetic); `data-smoke-profile={id}`; `data-smoke-cosmetics`; exact strings "Website preferences" (settings), "Test your DBD knowledge" (worldle), NO "Something went wrong" on boot; ~3.2s mount budget.
6. Scroll contract: `.overflow-y-auto` hosts inside main (FAB/pull-refresh/CTA padding), `.nav-scroll` on nav tracks, `[data-no-swipe]` escape hatch.
7. Global data names: `DATABASE`, `TIMELINE_DATA`, `COSMETICS_CATALOG`, `COMMUNITY_CONTENT`, `WORLDLE_DATA` untouched.
8. capacitor.config.json webDir "web"; no INTERNET permission; launch overlay globals (`__hideLaunchOverlay`); `window.onerror`/`unhandledrejection` loggers; backup schemaVersion=1 + newer-version rejection.

## Top risks (checklist for final QA)
1. Smoke hooks + exact strings · 2. Theme CSS variables bridged · 3. KILLER_STATS format · 4. Route audit/quotes · 5. Scroll containers · 6. Deep links (8 params) + uiState round-trip · 7. Favorites on all 6 surfaces · 8. Share codec v1/v2 · 9. Backup schema v1 · 10. Owned-only derivation (prestige≥1 ⇒ teachables) · 11. Worldle state machine · 12. Asset-pack image chain · 13. Capacitor optional-chaining · 14. PerkDescriptionBlock dual-mode · 15. Do not delete "shadowed" modals (Lore/Power used by Timeline) · 16. Do not remove dead-but-contract code (PremadeBuildsView, POWER_MECHANICS, homeTiles normalization) · 17. Meta/legal files exact names.
