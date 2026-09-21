// It's in the name - AI generation Worker (name-tool.arkeod.workers.dev)
// POST {pitch, comparables[], niche_words, crowded[]} -> {fantasy, names[], cached}
// Secrets: ANTHROPIC_API_KEY. Bindings: KV (rate limit + cache).
// Deployed via tools/deploy-name-tool.ps1-style API calls; source of truth is this file.

const ALLOWED_ORIGINS = ["https://giesweekly.com", "http://localhost:8792"];
const DAILY_LIMIT = 30;

const SYSTEM = `You are naming a video game. Not describing it, naming it.

THE BAR
A great name means more than the game does. "Hell Let Loose" is an idiom with dread inside it. "Titanfall" is an event you can feel. "BioShock" welds a science to a shock and invents a world. "Firewatch" is a job that sounds like a warning. "Myst" is a place that never existed and always did. "Limbo" is one ordinary word the game repossesses forever. "Spiritfarer" is a kindness in one compound. "Unpacking" is the whole mechanic, said gently. Any name that could caption a screenshot instead of headlining a franchise fails.

STEP 1: TONE
Before anything else, fix the emotional temperature of this pitch in two or three adjectives: warm and unhurried, loud and unserious, grim and procedural, wry and melancholy, mythic and violent, tender and precise. Every candidate must sit at that temperature.
A solemn name on a lighthearted game is a failure, not sophistication. If the pitch is cozy, funny, fond, fast or absurd, then funeral, legal, medical, forensic and disaster vocabulary is banned outright, however clever the double meaning.
If the pitch is warm, the winning name should make someone smile before they understand it.

STEP 2: FANTASY
State the player fantasy in one sentence: what it FEELS like, not the features.

STEP 3: BRAINSTORM, PRIVATE, AT LEAST 30 CANDIDATES
Work every register below, including the ones that do not come easily. Force yourself to produce at least three candidates in each:
  idiom: a set phrase from the game's world carrying a second meaning
  jargon: insider vocabulary of the setting that outsiders find evocative
  event: the moment everything changes, as a noun
  place: the setting named like a character, real or invented
  name: a person's name, a mythic name, or a coined proper noun that sounds like it already existed
  coinage: a portmanteau or compound that invents a category in one word
  collision: two words from incompatible worlds welded together
  plain: one ordinary word this game would permanently redefine
  literary: the register novels and films in this territory use for titles

STEP 4: QUOTA, HARD
Your untrained default is the two-word English idiom and the professional-jargon phrase. That default is a rut and most of it is interchangeable between games. The 10 you return MUST satisfy all of:
  at least 3 are a single word
  at least 1 has register "name" and at least 1 has register "place"
  at least 1 has register "coinage" or "collision"
  at most 3 are two-word English idioms
  at most 2 draw on the same source domain (law, weather, mining, climbing, medicine, the sea)
  no two share a head noun
Fill the quota first. Then let the remainder be your best work.

STEP 5: KILL
Cut anything that: describes a feature; sounds committee-approved; explains itself; borrows a word, pattern or suffix from the famous examples above or from COMPARABLE TITLES; uses a CROWDED word; is edgy or political; is region-locked (British road signs, Latin tags, archaic festivals, local landmarks) unless the pitch is set there; reaches for death, grief, guilt, inheritance or paperwork when the pitch did not.

STEP 6: FRANCHISE TEST
Every survivor passes all four:
  say it: a stranger spells it correctly after hearing it once
  wear it: it works as a logo, and as fan shorthand in three or four letters
  carry it: a sequel could be numbered after it and still make sense
  own it: it is not already the obvious title of a well-known book, film or song

Rules: 1 to 3 words. Return exactly 10. Each gets a "why" of 12 words or fewer: what it evokes, never why it markets. "register" must be exactly one of: idiom, jargon, event, place, name, coinage, collision, plain, literary.

Output STRICT JSON only, no fences:
{"fantasy": "...", "names": [{"name": "...", "register": "...", "why": "..."}]}`;

function cors(origin) {
  const o = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---- tags mode: read a pitch into Steam tags + two comps for the comparables matcher (benchmarked 2026-09-02) ----
const TAGS_DAILY_LIMIT = 100;
const TAGS = ["Adventure","Visual Novel","Anime","Cute","Simulation","Strategy","RTS","Wargame","Grand Strategy","Action RTS","3D","2D","Realistic","Tanks","War","Cold War","Indie","Interactive Fiction","Sci-fi","Singleplayer","Story Rich","Replay Value","Choices Matter","Multiple Endings","Turn-Based Strategy","Fantasy","Turn-Based","Turn-Based Tactics","Turn-Based Combat","Tactical","Hex Grid","Dark Fantasy","Casual","Puzzle","City Builder","Tabletop","Board Game","God Game","Solitaire","Top-Down","Pixel Graphics","Medieval","Action","Racing","Gore","Violent","FPS","Classic","Post-apocalyptic","Boomer Shooter","Rogue-like","Mystery Dungeon","Rogue-lite","Real Time Tactics","Isometric","Atmospheric","Demons","Magic","Vikings","Tower Defense","Survival","Action Roguelike","Minimalist","Auto Battler","Combat","Free to Play","VR","Action-Adventure","Time Manipulation","Side Scroller","Female Protagonist","2D Platformer","Swordplay","Score Attack","Controller","Bullet Hell","Nature","PvE","Colorful","Multiplayer","Card Game","Rhythm","Music","Soundtrack","RPG","Party-Based RPG","Fast-Paced","Experimental","Comedy","Point & Click","Puzzle-Platformer","Platformer","2D Fighter","Fighting","Shooter","4 Player Local","Funny","Local Multiplayer","Arena Shooter","PvP","Exploration","Relaxing","Open World","Beautiful","Walking Simulator","First-Person","Lara Croft","Third Person","Stealth","Early Access","Psychological Horror","Horror","Nudity","Survival Horror","Memes","Life Sim","Historical","Mining","Building","Base-Building","Dungeon Crawler","Sexual Content","Hentai","LGBTQ+","NSFW","Mature","Romance","JRPG","Shoot 'Em Up","Faith","Difficult","Grid-Based Movement","Action RPG","Hack and Slash","Character Customization","Local Co-Op","Cats","Co-op","Crafting","Management","Capitalism","Massively Multiplayer","MMORPG","Lovecraftian","Supernatural","Robots","Surreal","Mystery","Dark","Psychological","Zombies","On-Rails Shooter","Emotional","Economy","Detective","Great Soundtrack","Mouse only","Strategy RPG","Alternate History","RPGMaker","Resource Management","Immersive Sim","Cooking","Dark Humor","Heist","Crime","America","Online Co-Op","Animation & Modeling","Design & Illustration","Game Development","Medical Sim","Logic","Vehicular Combat","Military","Hero Shooter","Level Editor","Sandbox","Choose Your Own Adventure","Moddable","Hand-drawn","Text-Based","Comic Book","Stylized","Noir","Drama","3D Platformer","Collectathon","Short","Family Friendly","Skateboarding","Cartoon","Space","Retro","Western","Real-Time","Underground","Linear","Real-Time with Pause","Team-Based","Futuristic","CRPG","Nonlinear","Creature Collector","Roguelike Deckbuilder","Deckbuilding","Trading Card Game","Card Battler","Perma Death","Party","Minigames","Party Game","Dragons","Satire","Arcade","Fox","Souls-like","Utilities","Software","Voice Control","Conversation","Tutorial","Gaming","Procedural Generation","Artificial Intelligence","Metroidvania","Dark Comedy","Lore-Rich","Farming Sim","Driving","Loot","Clicker","Parody","Superhero","Beat 'em up","Competitive","1980s","Physics","Third-Person Shooter","Trivia","Dating Sim","Education","Movie","Thriller","Character Action Game","Spectacle fighter","Investigation","Conspiracy","Automobile Sim","Sports","Cinematic","Philosophical","Underwater","Musou","Science","Split Screen","Flight","Cartoony","1990's","Old School","Silent Protagonist","Dinosaurs","Typing","Open World Survival Craft","Hunting","Narration","2.5D","Hidden Object","Psychedelic","Tactical RPG","e-sports","World War I","Vampire","Experience","Feature Film","Extraction Shooter","Gun Customization","Cult Classic","Top-Down Shooter","Politics","Political","Immersive","Football (Soccer)","Precision Platformer","Time Management","Transportation","Diplomacy","Mechs","Match 3","Villain Protagonist","Lemmings","Web Publishing","Automation","Twin Stick Shooter","Abstract","4X","Addictive","Word Game","3D Vision","Kickstarter","World War II","Blood","Combat Racing","Cozy","Wholesome","Agriculture","Transhumanism","LEGO","Ninja","Snow","Pirates","Naval Combat","Battle Royale","Co-op Campaign","Aliens","Sequel","Otome","Time Travel","Trading","Gothic","Quick-Time Events","Escape Room","Nostalgia","Voxel","Parkour","Steampunk","Mythology","Cyberpunk","Dog","Submarine","Dwarf","GameMaker","6DOF","Space Sim","Electronic","Martial Arts","Pinball","Illuminati","Trains","Inventory Management","Bowling","Idler","Farming","Colony Sim","Audio Production","8-bit Music","Rome","Gambling","Runner","Football (American)","Fishing","Music-Based Procedural Generation","Bullet Time","Dystopian","3D Fighter","Remake","Pool","FMV","Destruction","Modern","Unforgiving","Job Simulator","Shop Keeper","Hobby Sim","360 Video","Narrative","Asymmetric VR","Assassin","Sokoban","Offroad","Social Deduction","Werewolves","Hacking","Naval","Political Sim","Bikes","BMX","Hockey","Dynamic Narration","Games Workshop","Dungeons & Dragons","Episodic","Asynchronous Multiplayer","Dice","Sailing","Class-Based","Traditional Roguelike","Video Production","Rugby","Looter Shooter","Sniper","Spelling","MOBA","Intentionally Awkward Controls","Horses","Boxing","Warhammer 40K","Snooker","Touch-Friendly","Wrestling","Instrumental Music","Programming","Roguevania","Mahjong","Well-Written","Motorbike","Masterpiece","Epic","Foreign","Baseball","Software Training","Jet","Jump Scare","Cricket","Rock Music","Photo Editing","Spaceships","Motocross","ATV","Mars","Time Attack","Documentary","Steam Machine","Ambient","Mod","Chess","Skating","Golf","Cycling","Based On A Novel","Benchmark","Outbreak Sim","Basketball","Boss Rush","Skiing","Tennis","Mini Golf","Snowboarding","Electronic Music","Hardware","Crowdfunded","Archery","Reboot","Volleyball","TrackIR","Birds","Batman","Coding","VR Only","Elf","Free To Play"];
const TAG_SYSTEM = `You classify a video game pitch into Steam's tag vocabulary so a comparables matcher can use it.

Return ONLY a JSON object, no prose, no code fence:
{"tags": [...], "perspective": ... , "mode": ..., "comps": [...]}

Rules:
- "tags": 3 to 6 tag names copied EXACTLY from the tag list below, most defining first. Prefer genre and mechanic tags (what the player does) over tone or setting. Include tone or setting tags only after the genre is covered.
- "perspective": one of First-Person, Third Person, Top-Down, Isometric, Side Scroller, 2D, 3D, Pixel Graphics, Hand-drawn, Anime, VR, or null when the pitch neither states nor strongly implies it.
- "mode": one of Singleplayer, Multiplayer, Co-op, Online Co-Op, Local Co-Op, Local Multiplayer, PvP, Massively Multiplayer, or null when not stated.
- "comps": up to 2 real, released Steam games that play like this pitch, exact official titles. Prefer well-known titles with two or more words.
- Never invent tags. Never output a tag that is not in the list.

Tag list:
${TAGS.join(", ")}`;

async function tagsMode(pitch, request, env, headers) {
  const cacheKey = "t:v1:" + await sha256(pitch);
  const cached = await env.KV.get(cacheKey);
  if (cached) return new Response(cached.replace('"cached":false', '"cached":true'), { headers });

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const rlKey = `rlt:${ip}:${day}`;
  const used = parseInt((await env.KV.get(rlKey)) || "0", 10);
  if (used >= TAGS_DAILY_LIMIT)
    return new Response(JSON.stringify({ error: "daily limit reached", limit: TAGS_DAILY_LIMIT }), { status: 429, headers });
  await env.KV.put(rlKey, String(used + 1), { expirationTtl: 90000 });

  const apiResp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      output_config: { effort: "low" },
      system: [{ type: "text", text: TAG_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `Pitch:\n${pitch}` }],
    }),
  });
  if (!apiResp.ok) {
    const detail = await apiResp.text();
    return new Response(JSON.stringify({ error: "tags failed", status: apiResp.status, detail: detail.slice(0, 200) }), { status: 502, headers });
  }
  const api = await apiResp.json();
  if (api.stop_reason === "refusal") return new Response(JSON.stringify({ error: "request declined" }), { status: 422, headers });
  const text = (api.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  let out = null;
  try { out = m ? JSON.parse(m[0]) : null; } catch { out = null; }
  if (!out) return new Response(JSON.stringify({ error: "parse failed" }), { status: 502, headers });

  const byLower = new Map(TAGS.map(t => [t.toLowerCase(), t]));
  const norm = v => (v == null ? null : (byLower.get(String(v).toLowerCase()) || null));
  const tags = [];
  for (const t of (Array.isArray(out.tags) ? out.tags : [])) { const k = norm(t); if (k && !tags.includes(k)) tags.push(k); }
  const payload = JSON.stringify({
    tags: tags.slice(0, 6),
    perspective: norm(out.perspective),
    mode: norm(out.mode),
    comps: (Array.isArray(out.comps) ? out.comps : []).map(x => String(x).slice(0, 80).trim()).filter(Boolean).slice(0, 2),
    cached: false,
  });
  await env.KV.put(cacheKey, payload, { expirationTtl: 604800 });
  return new Response(payload, { headers });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = cors(origin);
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (request.method !== "POST")
      return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });

    let body;
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers }); }

    const pitch = String(body.pitch || "").slice(0, 600).trim();
    if (pitch.length < 20)
      return new Response(JSON.stringify({ error: "pitch too short" }), { status: 400, headers });
    if (body.mode === "tags") return tagsMode(pitch, request, env, headers);
    const comparables = (Array.isArray(body.comparables) ? body.comparables : []).slice(0, 12).map(x => String(x).slice(0, 80));
    const nicheWords = String(body.niche_words || "").slice(0, 300);
    const crowded = (Array.isArray(body.crowded) ? body.crowded : []).slice(0, 20).map(x => String(x).slice(0, 30));
    const genreTags = String(body.genre_tags || "").slice(0, 120);

    // cache: identical pitch+context never re-burns
    const cacheKey = "c:v4:" + await sha256(JSON.stringify([pitch, comparables, nicheWords, crowded, genreTags]));
    const cached = await env.KV.get(cacheKey);
    if (cached) return new Response(cached, { headers });

    // per-IP daily limit
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const day = new Date().toISOString().slice(0, 10);
    const rlKey = `rl:${ip}:${day}`;
    const used = parseInt((await env.KV.get(rlKey)) || "0", 10);
    if (used >= DAILY_LIMIT)
      return new Response(JSON.stringify({ error: "daily limit reached", limit: DAILY_LIMIT }), { status: 429, headers });
    await env.KV.put(rlKey, String(used + 1), { expirationTtl: 90000 });

    const user = `PITCH:
${pitch}

MARKET DATA (from analysis of 128,000+ Steam titles):
GENRE (dominant tags of the closest matches): ${genreTags || "unknown"}
COMPARABLE TITLES (closest gameplay matches): ${comparables.join("; ") || "none found"}
NICHE VOCABULARY (common title words among comparables): ${nicheWords || "none"}
CROWDED (do not use): ${crowded.join(", ") || "none"}`;

    const apiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 8000,
        output_config: { effort: "high" },
        fallbacks: "default",
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!apiResp.ok) {
      const detail = await apiResp.text();
      return new Response(JSON.stringify({ error: "generation failed", status: apiResp.status, detail: detail.slice(0, 300) }),
        { status: 502, headers });
    }
    const api = await apiResp.json();
    if (api.stop_reason === "refusal")
      return new Response(JSON.stringify({ error: "request declined" }), { status: 422, headers });

    let text = (api.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    if (text.startsWith("```")) text = text.split("```")[1].replace(/^json/, "").trim();
    let out;
    try { out = JSON.parse(text); }
    catch { return new Response(JSON.stringify({ error: "parse failed" }), { status: 502, headers }); }

    const payload = JSON.stringify({
      fantasy: String(out.fantasy || "").slice(0, 400),
      names: (out.names || []).slice(0, 12).map(n => ({
        name: String(n.name || "").slice(0, 60),
        strategy: String(n.register || n.strategy || "").slice(0, 60),
        why: String(n.why || "").slice(0, 300),
      })),
      cached: false,
    });
    await env.KV.put(cacheKey, payload, { expirationTtl: 604800 });
    return new Response(payload, { headers });
  },
};
