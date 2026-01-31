# Visual Memory: The "Where Did I Put That?" Killer

*A deep dive into building an AI-powered visual inventory system*

---

## What Does This Thing Actually Do?

You know that feeling when you're tearing apart your house looking for your keys, your charger, or that random cable you swore was "right there"? This app fixes that.

**The pitch:** Snap photos of your stuff. Later, just ask "Where's my red notebook?" and the app tells you—with a photo to prove it.

It's like having a photographic memory, except the memory belongs to GPT-4 and lives in the cloud.

---

## The Architecture (A.K.A. How the Magic Happens)

Think of this system as a three-act play:

### Act 1: The Capture
```
You → Camera → Supabase Storage → Database → Webhook → GPT-4o Vision → Embeddings
```

When you take a photo:
1. **Expo Camera** captures the image
2. **Supabase Storage** stores the file (the `images` bucket)
3. A row gets inserted into the `scans` table with just the image URL
4. A **database webhook** fires automatically
5. The `analyze-image` Edge Function wakes up and asks GPT-4o: *"What am I looking at?"*
6. GPT returns a description, detected objects, and room type
7. The description gets converted to a **vector embedding** (more on this below)
8. Everything gets saved back to the database

### Act 2: The Search
```
"Where's my charger?" → GPT extracts room → Vectorize query → Find matches → GPT picks best one → Answer
```

When you search:
1. GPT-4o-mini checks if you mentioned a room ("in the bedroom")
2. Your query becomes a vector embedding
3. **pgvector** finds the most similar image descriptions
4. GPT-4o looks at the top 3 candidates and picks the winner
5. You get a natural language answer + the photo

### Act 3: The Result
*"Your charger is on the nightstand in your bedroom"* + a photo of exactly that.

---

## The Tech Stack (And Why These Choices)

| Layer | Tech | Why |
|-------|------|-----|
| **Mobile** | React Native + Expo SDK 54 | Write once, run everywhere. Expo handles the camera/photo permissions nightmare. |
| **Backend** | Supabase | Postgres + Storage + Edge Functions + Realtime in one package. No separate servers to manage. |
| **Edge Functions** | Deno | Runs on Supabase's edge network. Fast cold starts. TypeScript native. |
| **AI - Vision** | GPT-4o | Best-in-class image understanding. Can describe scenes, identify objects, detect room types. |
| **AI - Search** | GPT-4o-mini | Fast and cheap for simple extraction tasks (pulling room names from queries). |
| **Embeddings** | text-embedding-3-small | OpenAI's embedding model. Converts text to 1536-dimensional vectors. |
| **Vector Search** | pgvector | PostgreSQL extension for similarity search. No separate vector database needed. |

### Why Supabase Over Firebase?

1. **Postgres is powerful.** Triggers, RPC functions, pgvector—it's a real database.
2. **Edge Functions use Deno.** Cleaner than Firebase Functions' Node.js setup.
3. **SQL is readable.** Firestore's NoSQL queries can get ugly fast.
4. **Row-level security.** Built-in, not bolted on.

### Why Two AI Models?

Cost and speed optimization:
- **GPT-4o** ($5/M input tokens): Used for complex tasks—image analysis, final answer generation
- **GPT-4o-mini** ($0.15/M input tokens): Used for simple extraction—"Is there a room name in this query?"

Running GPT-4o for every tiny task would burn money. GPT-4o-mini is 33x cheaper for simple jobs.

---

## The Database Schema

```sql
CREATE TABLE scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_url TEXT NOT NULL,
  description TEXT,
  room_label TEXT,
  detected_objects JSONB,
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT now()
);
```

**The `embedding` column is the secret sauce.** It stores a 1536-dimensional vector representing the semantic meaning of each image's description. When you search, your query becomes a vector too, and pgvector finds the closest matches using cosine similarity.

---

## The Folder Structure

```
visual-memory/
├── App.tsx                 # The entire app UI (simple, one file)
├── lib/
│   └── supabase.ts         # Supabase client initialization
└── supabase/
    └── functions/
        ├── analyze-image/  # Webhook: processes new photos
        └── search-items/   # API: handles search queries
```

**Notice there's no `components/` folder.** This is an MVP. The whole app is one file. Don't over-engineer early.

---

## Bugs We Hit (And How We Fixed Them)

### Bug #1: The Time That Wasn't a Time

**The problem:** Room inheritance logic checks if the last scan was within 10 minutes. But `new Date("08:52:27.046579")` returns garbage.

**Root cause:** The `created_at` column was type `time` instead of `timestamptz`. We were storing just the time, not the date.

**The fix:**
```sql
ALTER TABLE scans DROP COLUMN created_at;
ALTER TABLE scans ADD COLUMN created_at TIMESTAMPTZ DEFAULT now();
```

**Lesson:** Always use `TIMESTAMPTZ` for timestamps. Never `time` or `timestamp` (without timezone). PostgreSQL timezone handling is a minefield—`TIMESTAMPTZ` is the safe choice.

---

### Bug #2: The Desk That Was Definitely an Office

**The problem:** User takes a close-up photo of a desk. GPT says "Office" because desks are in offices... except this desk was in the bedroom.

**Root cause:** The GPT prompt listed valid rooms but didn't say what to do when the room wasn't visible.

**The fix:** Updated the prompt:
```
IMPORTANT: Only assign a specific room if you can clearly see room context
(walls, furniture layout, multiple room features). If the image is a close-up
of an object/surface without visible room context, use 'Close-up' - do NOT
guess the room based on the object type alone.
```

**Lesson:** LLMs do what you tell them. If you don't explicitly say "don't guess," they'll guess. Be specific about edge cases.

---

### Bug #3: The Ambiguous Labels That Couldn't Exist

**The problem:** Fallback logic checked for labels like "Close-up" or "Surface", but the GPT prompt only allowed "Unknown" as the fallback.

**Root cause:** The ambiguous labels list and the GPT prompt were out of sync.

**The fix:** Added "Close-up" to the valid room options in the prompt.

**Lesson:** When you have validation/categorization logic in multiple places, they must stay synchronized. One source of truth is better than two.

---

## Smart Patterns Worth Stealing

### Pattern 1: Hybrid Search (Hard Filter + Vector Search)

Instead of searching the entire database:
```sql
-- BAD: Searches everything
SELECT * FROM scans
ORDER BY embedding <=> query_embedding
LIMIT 3;
```

Filter first, then search:
```sql
-- GOOD: Filters first, then searches
SELECT * FROM scans
WHERE room_label = 'Bedroom'  -- Hard filter
ORDER BY embedding <=> query_embedding  -- Then vector search
LIMIT 3;
```

**Why it matters:** If the user says "red thing in the bedroom," a fuzzy vector search might return a red cup from the kitchen. The hard filter guarantees bedroom-only results.

---

### Pattern 2: Temporal Context Inheritance

When GPT can't determine the room from a close-up shot, check what room the user was photographing 10 minutes ago:

```typescript
if (ambiguousLabels.includes(finalRoom)) {
  const { data: history } = await supabase
    .from('scans')
    .select('room_label, created_at')
    .not('room_label', 'in', '("Unknown","Close-up")')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (history && (Date.now() - new Date(history.created_at)) < 10 * 60 * 1000) {
    finalRoom = history.room_label; // Inherit from recent scan
  }
}
```

**Why it works:** Users typically photograph multiple things in the same room. If they took a photo of the bedroom 2 minutes ago, the close-up of a drawer is probably also in the bedroom.

---

### Pattern 3: Two-Stage AI Search

**Stage 1:** Vector similarity finds candidates (fast, cheap, fuzzy)
**Stage 2:** LLM picks the winner (slow, smart, accurate)

This is like Google showing you 10 results, then you pick the best one—except the "you" is GPT-4.

```typescript
// Stage 1: Get candidates via embeddings
const candidates = await supabase.rpc('match_images', {
  query_embedding: queryVector,
  match_count: 3
});

// Stage 2: Let GPT pick the best one
const response = await openai.chat({
  messages: [{
    role: "system",
    content: "Pick the best match from these 3 candidates..."
  }]
});
```

**Why not just use GPT for everything?** Cost. Embedding search costs ~$0.02 per 1M tokens. GPT-4 costs $5 per 1M tokens. Use the cheap tool for filtering, expensive tool for precision.

---

### Pattern 4: Forced JSON Responses

```typescript
response_format: { type: "json_object" }
```

This makes GPT return valid JSON every time. No more parsing nightmares. No more "Sure! Here's the JSON:" preamble.

**Always use this when you need structured data from an LLM.**

---

## Things I'd Do Differently

### 1. Add a Loading Skeleton
Right now the UI just shows "Searching..." text. A skeleton loader would feel faster.

### 2. Batch Processing
If a user uploads 50 photos, each triggers a separate webhook. A queue system would be smarter.

### 3. Offline Support
Photos should save locally first, then sync. Currently requires internet.

### 4. Better Error Messages
When GPT-4o fails, the user sees "Error processing image." That's not helpful. Surface the actual problem.

---

## The Mental Model for AI-Powered Apps

Think of GPT as an extremely capable but literal intern:
- They'll do exactly what you say
- They won't do what you don't say
- They'll make assumptions you didn't expect
- Clear instructions = good results

**The prompt is your spec.** If the spec is vague, the output is unpredictable.

**Embeddings are compressed meaning.** When you convert "red notebook on the kitchen counter" to a vector, you're compressing that sentence into 1536 numbers that capture its semantic essence. Similar meanings = similar vectors.

**Vector search finds "vibes."** It doesn't match keywords—it matches meaning. "Where's my charger" finds "phone cable on nightstand" because they're semantically close.

---

## Commands You'll Need

```bash
# Start the app
npm start

# Deploy a function after changes
npx supabase functions deploy analyze-image
npx supabase functions deploy search-items

# Link to your Supabase project (first time)
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF

# Check function logs
npx supabase functions logs analyze-image
```

---

## Final Thoughts

This project is a great example of **modern AI-native architecture**:
- The AI isn't a feature—it's the foundation
- The database isn't just storage—it's a vector search engine
- The backend isn't servers—it's edge functions that wake up on demand

The whole thing costs pennies to run (Supabase free tier + pay-per-use OpenAI) and could scale to millions of images without architecture changes.

That's the power of building on modern infrastructure. You get to focus on the product, not the plumbing.

---

*Written for future-me and anyone else who inherits this codebase. May your items never be lost again.*
