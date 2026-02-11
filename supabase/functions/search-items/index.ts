import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

// Cosine similarity between two vectors
function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

Deno.serve(async (req) => {
  try {
    const { query, room } = await req.json();

    // 1. Extract room AND main item from query using GPT
    const extractResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Extract the room (if mentioned) and the main item/object being searched for.
            Valid rooms: Kitchen, Living Room, Bedroom, Bathroom, Office, Garage, Outdoors.
            Return JSON: { "room": "Name" or null, "item": "the main object being searched for" }
            Examples:
            - "where is my suitcase" -> { "room": null, "item": "suitcase" }
            - "what color is the water bottle in the kitchen" -> { "room": "Kitchen", "item": "water bottle" }
            - "find my keys in the bedroom" -> { "room": "Bedroom", "item": "keys" }`
          },
          { role: "user", content: query }
        ]
      })
    });
    const extractData = await extractResponse.json();
    const extracted = JSON.parse(extractData.choices[0].message.content);
    const roomFilter = room || extracted.room || null;
    const searchItem = extracted.item?.toLowerCase() || query.toLowerCase();
    console.log(`Extracted - room: ${roomFilter}, item: ${searchItem}`);

    // 2. Generate embeddings for both the full query AND the specific item
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: [query, searchItem]  // Batch both embeddings
      })
    });
    const embeddingData = await embeddingResponse.json();
    const queryVector = embeddingData.data[0].embedding;
    const itemVector = embeddingData.data[1].embedding;

    // 3a. Scene-level vector similarity search (original approach)
    const { data: vectorImages, error: vectorError } = await supabase.rpc('match_images', {
      query_embedding: queryVector,
      match_threshold: 0.1,
      match_count: 5,
      room_filter: roomFilter
    });

    if (vectorError) throw vectorError;

    // 3b. Semantic object-level search using object embeddings
    // Fetch recent scans with detected_objects
    let objectQuery = supabase
      .from('scans')
      .select('id, image_url, description, room_label, detected_objects')
      .not('detected_objects', 'is', null)
      .order('created_at', { ascending: false })
      .limit(50);

    if (roomFilter) {
      objectQuery = objectQuery.eq('room_label', roomFilter);
    }

    const { data: scansWithObjects } = await objectQuery;

    // Find scans where any object embedding is semantically similar to the search item
    const OBJECT_SIMILARITY_THRESHOLD = 0.5;  // Tune this threshold
    const semanticMatches: { scan: any; bestMatch: string; similarity: number }[] = [];

    if (scansWithObjects) {
      for (const scan of scansWithObjects) {
        if (Array.isArray(scan.detected_objects)) {
          let bestMatchLabel = '';
          let bestSimilarity = 0;

          for (const obj of scan.detected_objects) {
            if (obj.embedding && Array.isArray(obj.embedding)) {
              const similarity = cosineSimilarity(itemVector, obj.embedding);
              if (similarity > bestSimilarity) {
                bestSimilarity = similarity;
                bestMatchLabel = obj.label;
              }
            }
          }

          if (bestSimilarity >= OBJECT_SIMILARITY_THRESHOLD) {
            semanticMatches.push({
              scan,
              bestMatch: bestMatchLabel,
              similarity: bestSimilarity
            });
          }
        }
      }
    }

    // Sort semantic matches by similarity (best first)
    semanticMatches.sort((a, b) => b.similarity - a.similarity);
    console.log(`Semantic object search found ${semanticMatches.length} matches above threshold ${OBJECT_SIMILARITY_THRESHOLD}`);
    if (semanticMatches.length > 0) {
      console.log(`Best match: "${semanticMatches[0].bestMatch}" with similarity ${semanticMatches[0].similarity.toFixed(3)}`);
    }

    // Merge results: prioritize semantic object matches, then vector matches
    const seenIds = new Set<string>();
    const images: any[] = [];

    // Add semantic matches first (most precise for item searches)
    for (const match of semanticMatches) {
      if (!seenIds.has(match.scan.id) && images.length < 5) {
        seenIds.add(match.scan.id);
        // Add the matched object info for context
        match.scan._matchedObject = match.bestMatch;
        match.scan._matchSimilarity = match.similarity;
        images.push(match.scan);
      }
    }

    // Then add vector search results
    for (const img of (vectorImages || [])) {
      if (!seenIds.has(img.id) && images.length < 5) {
        seenIds.add(img.id);
        images.push(img);
      }
    }

    if (images.length === 0) {
      return new Response(JSON.stringify({ answer: "No matching items found.", image: null }), { headers: { "Content-Type": "application/json" } });
    }

    // --- THE HYBRID CONTEXT ---
    // We format the text so GPT-4o sees BOTH its own description AND Qwen3-VL's object list
    const descriptionsContext = images.map((img: any, index: number) => {

      // Parse Qwen3-VL objects back into a readable list
      let objectList = "None specific.";
      if (Array.isArray(img.detected_objects)) {
          // Take top 20 objects to avoid token limits
          objectList = img.detected_objects.slice(0, 20).map((o: any) => o.label).join(", ");
      }

      // Include semantic match info if available
      const matchInfo = img._matchedObject
        ? `\n      - SEMANTIC MATCH: "${img._matchedObject}" (similarity: ${(img._matchSimilarity * 100).toFixed(1)}%)`
        : '';

      return `
      [Candidate Image ${index}]
      - Room: ${img.room_label || "Unknown"}
      - Scene Summary (GPT): ${img.description}
      - Detailed Object List (Qwen3-VL): ${objectList}${matchInfo}
      `;
    }).join("\n---\n");

    // 4. Ask GPT-4o to Judge
    const chatResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You are a helpful assistant finding lost items.
            You have a User Query and candidate images. Each image has a Scene Summary and a Detailed Object List.

            Compare the User Query against BOTH the Summary and the Object List.
            - If an image has a "SEMANTIC MATCH" indicator, that object is semantically similar to what the user is searching for (e.g., "stanley cup" matches "water bottle").
            - Qwen3-VL's Object List is accurate for specific items.
            - GPT's Summary provides context about location and surroundings.

            Return JSON:
            {
               "answer": "Helpful text describing where the item is located. Include relevant context from the scene.",
               "match_index": integer (0, 1, 2, ...) or null if no good match
            }`
          },
          { 
            role: "user", 
            content: `User Query: ${query}\n\nCandidates:\n${descriptionsContext}` 
          }
        ]
      })
    });

    const aiContent = JSON.parse((await chatResponse.json()).choices[0].message.content);
    
    let finalImage = null;
    if (aiContent.match_index !== null && images[aiContent.match_index]) {
      finalImage = images[aiContent.match_index].image_url;
    }

    return new Response(JSON.stringify({ 
      answer: aiContent.answer, 
      image: finalImage 
    }), { headers: { "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});