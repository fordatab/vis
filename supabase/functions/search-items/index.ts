import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

Deno.serve(async (req) => {
  try {
    const { query, room } = await req.json();

    // 1. Extract room from query using GPT (if not provided)
    let roomFilter = room || null;

    if (!roomFilter) {
      const extractResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `Extract the room from the user's query if mentioned. Valid rooms: Kitchen, Living Room, Bedroom, Bathroom, Office, Garage, Outdoors. Return JSON: { "room": "Room Name" or null if no room mentioned }`
            },
            { role: "user", content: query }
          ]
        })
      });
      const extractData = await extractResponse.json();
      const extracted = JSON.parse(extractData.choices[0].message.content);
      roomFilter = extracted.room;
    }

    console.log("Room filter:", roomFilter);

    // 2. Vectorize Query
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: query
      })
    });
    const embeddingData = await embeddingResponse.json();
    const queryVector = embeddingData.data[0].embedding;

    // 3. Get Top 3 Candidates (Low Threshold) with optional room filter
    const { data: images, error } = await supabase.rpc('match_images', {
      query_embedding: queryVector,
      match_threshold: 0.1, // Keep it loose
      match_count: 3,
      room_filter: roomFilter // null means no filter
    });

    if (error) throw error;
    if (!images || images.length === 0) {
      return new Response(JSON.stringify({ 
        answer: "I couldn't find anything like that.", 
        image: null 
      }), { headers: { "Content-Type": "application/json" } });
    }

    // 3. Prepare Context for GPT-4o
    // We explicitly label them Index 0, 1, 2 so the AI can point to one.
    const descriptionsContext = images.map((img: any, index: number) => 
      `[Image Index: ${index}] Description: ${img.description}`
    ).join("\n\n");

    // 4. Ask GPT-4o to PICK the right image
    const chatResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      
      body: JSON.stringify({
        model: "gpt-4o",
        response_format: { type: "json_object" }, // FORCE JSON
        messages: [
          { 
            role: "system", 
            content: `You are a helpful assistant finding lost items.
            You will receive a User Query and 3 Candidate Image Descriptions.
            
            Task:
            1. Read the descriptions.
            2. Decide which image (if any) contains the answer.
            3. Return a JSON object with:
               - "answer": A helpful text response telling the user where the item is.
               - "match_index": The integer index (0, 1, or 2) of the matching image. If NO image matches, return null.
            ` 
          },
          { 
            role: "user", 
            content: `User Query: ${query}\n\nCandidates:\n${descriptionsContext}` 
          }
        ]
      })
    });

    const chatData = await chatResponse.json();
    
    // 5. Parse the AI's Choice
    const aiContent = JSON.parse(chatData.choices[0].message.content);
    
    let finalImage = null;
    
    // If the AI picked an index (0, 1, or 2), use that image.
    // If it returned null, send back no image.
    if (aiContent.match_index !== null && images[aiContent.match_index]) {
      finalImage = images[aiContent.match_index].image_url;
    }

    return new Response(JSON.stringify({ 
      answer: aiContent.answer, 
      image: finalImage 
    }), { 
      headers: { "Content-Type": "application/json" } 
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});