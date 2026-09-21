# IdeaBox Arena — UI/UX Design Brief (research → rebuild, 4 rounds)

Researched 2026 dashboard-design, EdTech/gamification and dark-mode accessibility guidance,
then applied it to the Arena rebuild. After instructor feedback on round 1
("the layout, the way the menus are, the emojis, two separate logins"), a second research
round covered navigation shells, icon systems, and unified login — leading to the v3 shell.
Later rounds decongested the app (one job per page) and added a vision pass + password
logins. Sources at the bottom.

## Round 4 — feedback → fixes (decongestion)

| Feedback | Fix shipped |
|---|---|
| "It seems too congested to be on the same page" | The monolithic instructor console (10 cards + 2 tables in one scroll) was **split into five separate sidebar pages**: Run the day (clock/brain/board mode), Start tracker (live timing), People (roster + accounts), Grading (AI grade + override), Standings (tables + exports + reset). Each page opens with one lead sentence; mobile tab bar became scrollable |
| "It's confusing for the students and still too much per page" | Student home rebuilt as **one column of three numbered steps** — 1 Read your mission, 2 Paste your work and hand it in, 3 Your grade. The 4-card right rail was removed (progress + nickname moved to Class board); links/images collapsed behind "optional"; jargon renamed (Arena Board → Class board, Self-check → Practice check, arena name → nickname). Nav labels are plain: Today, Class board, All missions, How it works |
| "Can the agent really analyze images?" | Tested free vision models live (qwen2.5-vl read text drawn in a test image). Built the **Vision pass**: uploaded images are described by a vision model and attached to the grader's prompt as extra evidence — on by default, toggleable, never blocks grading, human keeps final say |
| "Use passwords, not name-selecting" | One username + password form for everyone; accounts live in `data/users.json`; instructor can reset passwords and add students (auto-generated credentials) |

## Round 2 — feedback → fixes (v3)

| Feedback | Research finding | Fix shipped |
|---|---|---|
| "The way the menus are" | Desktop: sidebar 220–260px, icons must **supplement labels**, clear active state (ALF Design, 2026). Below ~768px the sidebar breaks down → **bottom tab bar** in the thumb zone, 3–5 destinations (Appy Pie 2026, Material/UX.SE) | New app shell: fixed **sidebar** on desktop + **bottom tab bar** on mobile. Items are **role-aware** — students never see the Console, instructors never see My Space |
| "The fact that you used emojis" | Emojis render differently on every OS, can't be recolored, read as unprofessional in UI chrome; professional products use one consistent SVG stroke-icon system (Lucide/Heroicons-style) — emojis belong only in user-generated content (onpage-optimierung 2026; Medium icon guidelines; uiuxnews iconography) | A full **inline SVG sprite — 31 stroke icons**, one 2px weight, `currentColor`, zero external files: nav, buttons, toasts, section headers, badge icons, ranked medal circles. Automated audit: **0 emoji codepoints** left in the app |
| "Seeing instructor login instead of one login interface" | Multi-role school tools: **one unified login**, role chosen on a single screen, then routed to that role's workspace (Authgear login-UX guide 2025; UX.SE; practitioner consensus) | A single **sign-in gate**: one card with Student / Instructor tabs, one action each. Session persists across refreshes (sessionStorage); Sign out returns to the gate |
| "The arrangement" | Most-important info top-left; group by task; one primary action per screen; persistent global context in a top bar (sidebar guide 2026) | My Space is now a **2-column workspace** (brief + submit dominant; assignment, progress, grades in a rail). The live clock is a **persistent chip in the top bar** on every screen. Toasts replace scattered inline alerts |

## Round 1 — what the research says (condensed)

**1. Dashboard design (Fanruan, UXPin, Aufait UX, Refero, Sessions)**
- Visual hierarchy first, decoration last: most important information top-left, 3-to-5 KPIs
  top row, trend/detail below. Users **scan, they don't read** — typography (size/weight)
  does more work than color.
- **8 px spacing grid**; whitespace separates better than borders. Dark mode *compresses*
  perceived whitespace → increase padding.
- Max **3 typography levels**. Limit to **3–5 semantic colors**. Subtle elevation
  (1 px borders / soft shadows), no heavy drop shadows.
- One sentence of purpose per screen; signal over decoration; progressive disclosure.

**2. Teen / EdTech UX & gamification (Lollypop, MoldStud, Abbacus)**
- Timely feedback loops, small wins, badges, progress visibility, personalization —
  "students feel confident and in control → they stay engaged."
- The **learning action must stay visually dominant** — never let reward animation outrank
  the task itself.
- **Avoid reward inflation**: small feedback for ordinary actions, moderate for milestones,
  rare for exceptional. Achievement info must never live in animation alone.
- Short, optional celebration animations (confetti/badge unlock), disabled under reduced-motion.
- Mobile-first: ~54% of traffic is mobile; touch targets ≥ 48 px; thumb-zone CTAs.

**3. Dark-mode accessibility (WCAG, dark-mode guides)**
- 4.5:1 contrast for normal text, 3:1 for large text/UI — in dark mode too.
- **Never pure black + pure white**: dark grey canvases (#0b–#12 range) + off-white text;
  max contrast causes halation for astigmatism.
- Visible **focus rings**, don't rely on color alone (pair with icons/text), clear disabled states.

## Applied in the rebuild

| Principle | Implementation |
|---|---|
| Hierarchy & scanning | Sticky live **clock chip** in the header (the #1 fact during a session) always visible; mission hero card leads the dashboard; 3-level type scale |
| 8 px grid + breathing room | Spacing tokens 4/8/12/16/24/32; roomier cards than v1 |
| Semantic color discipline | Gold = action/brand, green = success/on-time, red = warning/late, blue = info, purple = skills; every state also has an icon/text label |
| Accessible dark palette | Canvas `#0a0e18`, surfaces `#121927/#182238`, text `#edf1f9` — all body-text pairs ≥ 4.5:1; focus-visible rings everywhere; buttons meet 4.5:1 |
| Feedback loops | **Toast notifications** replace buried inline alerts; button press states; score count-up animation on grade reveal |
| Small wins without inflation | Personal-best banner, ▲/▼ deltas, badge shelf with subtle pop-in; confetti **only** for a new personal best, respects `prefers-reduced-motion` |
| Learning dominates | The brief + submit box stay the visual center; chrome is quiet |
| Teen-proof forms | **Draft autosave** (localStorage) so a refresh never loses a teenager's pasted work; character counter; drag-drop upload zone with file chips |
| Mobile-first | Nav collapses to a scrollable pill bar; ≥ 44 px targets; grids stack; sticky submit CTA on small screens |
| Empty/error states | Designed empty states (no students yet, no grades yet) instead of dead tables; graceful demo banner |
| Motion discipline | All animation gated behind `prefers-reduced-motion: no-preference` |

## Deliberately NOT added (research-backed restraint)
- XP/levels/streaks — reward inflation risk; the six-category brief is the motivation system
- Sound effects — classroom context (shared rooms, teacher projecting the board)
- External fonts/CDNs — the app must survive bad school networks (class constraint)

## Sources
- Fanruan — Top Admin Dashboard Design Ideas 2026 — https://www.fanruan.com/en/blog/top-admin-dashboard-design-ideas-inspiration
- UXPin — Dashboard Design Principles: The Definitive Guide (2026) — https://www.uxpin.com/studio/blog/dashboard-design-principles/
- Aufait UX — Dashboard Design Guide (2026) — https://www.aufaitux.com/blog/dashboard-design-examples-inspiration-best-practices/
- Refero — Dashboard UI Best Practices — https://refero.design/p/dashboard-ui-best-practices/
- Sessions.edu — Visual Hierarchy: Key UX Principles — https://www.sessions.edu/notes-on-design/visual-hierarchy-key-ux-principles-that-drive-results/
- Lollypop — UX Design in Education for Student Engagement — https://lollypop.design/blog/2025/july/ux-design-in-education-student-engagement/
- MoldStud — Enhancing UX in Educational Mobile Apps — https://moldstud.com/articles/p-enhancing-user-experience-ux-in-educational-mobile-apps-strategies-and-best-practices
- Abbacus — Building an Educational App With Gamification and Rewards — https://www.abbacustechnologies.com/how-to-build-an-educational-app-with-gamification-and-rewards/
- Design System Problems — Dark Mode Accessibility (Jan 2026) — https://designsystemproblems.com/accessibility-compliance/dark-mode-accessibility/
- Theme & Color — Accessible Dark Mode Color Palette — https://themeandcolor.com/blog/accessible-dark-mode-color-palette
- Accessibility Partners — WCAG Colour Contrast Guide — https://accessibilitypartners.ca/colour-contrast-for-web-accessibility/

### Round 2 sources (navigation, icons, unified login)
- Appy Pie — App Navigation Patterns: Tab Bar vs Hamburger (2026) — https://www.appypie.com/blog/app-navigation-patterns
- ALF Design Group — Sidebar Design for Web Apps: UX Best Practices (2026) — https://www.alfdesigngroup.com/post/improve-your-sidebar-design-for-web-apps
- UX Stack Exchange — When to use Bottom navigation vs Tabs — https://ux.stackexchange.com/questions/102439/android-ux-when-to-use-bottom-navigation-and-when-to-use-tabs
- onpage-optimisierung — SVG Icons vs Emojis: Warum Profis auf SVG setzen (2026) — https://www.onpage-optimierung.de/blog/svg-icons-vs-emojis/
- Michael Garber — Do emojis belong in UI design? — https://medium.com/@garbermm/do-emojis-belong-in-ui-design-evaluating-their-place-in-modern-products-a0e579a3e3db
- UI/UX News — The Best Iconography in UI Design: Visual Clarity (2025) — https://uiuxnews.in/iconography-ui-design-visual-clarity/
- Authgear — Login & Signup UX: The 2025 Guide — https://www.authgear.com/post/login-signup-ux-guide/
- UX Stack Exchange — Login for multiple users (single form + roles) — https://ux.stackexchange.com/questions/44806/login-for-multiple-users
