import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

// Initialize Supabase Client (Admin Mode)
const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

Deno.serve(async (req) => {
  try {
    // 1. Parse the Webhook Payload (The data sent by the database)
    const payload = await req.json();
    const record = payload.record; // This is the new row (image_url, id)

    if (!record.image_url) {
      return new Response("No image URL found", { status: 400 });
    }

    console.log(`Processing Image ID: ${record.id}`);

    // 2. Ask GPT-4o to describe the image
    const visionResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are a visual inventory assistant. Analyze this image. Return a JSON object with three fields: 'room' (one of: Kitchen, Living Room, Bedroom, Bathroom, Office, Garage, Outdoors, Close-up, Unknown), 'description' (a detailed paragraph describing location and items), and 'objects' (an array of specific item names found). IMPORTANT: Only assign a specific room if you can clearly see room context (walls, furniture layout, multiple room features). If the image is a close-up of an object/surface without visible room context, use 'Close-up' - do NOT guess the room based on the object type alone."
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image." },
              { type: "image_url", image_url: { url: record.image_url } }
            ]
          }
        ],
        response_format: { type: "json_object" }
      })
    });

    const visionData = await visionResponse.json();

    console.log("FULL GPT RESPONSE:", visionData);


    const aiContent = JSON.parse(visionData.choices[0].message.content);
    const room = aiContent.room;
    const description = aiContent.description;
    const objects = aiContent.objects;

    let finalRoom = aiContent.room; // e.g., "Unknown" or "Kitchen"
    
    // 1. Define what counts as a "Bad" label
    const ambiguousLabels = ["Unknown", "Close-up", "Surface", "Wall", "Floor", "Object"];
    
    // 2. The Fallback Logic
    if (ambiguousLabels.includes(finalRoom) || !finalRoom) {
      console.log("Room is ambiguous. Checking history...");

      // Query the LAST scan that had a valid room label
      const { data: history } = await supabase
        .from('scans')
        .select('room_label, created_at')
        .not('room_label', 'in', `(${ambiguousLabels.map(l => `"${l}"`).join(',')})`) // Exclude bad labels
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      
        
      console.log(history);
      if (history) {
        // Check time difference (e.g., 10 minutes)
        const lastTime = new Date(history.created_at).getTime();
        const currentTime = new Date().getTime();
        const diffMinutes = (currentTime - lastTime) / 1000 / 60;

        if (diffMinutes < 10) {
           console.log(`Inheriting room '${history.room_label}' from previous scan (${diffMinutes.toFixed(1)} mins ago).`);
           finalRoom = history.room_label; // INHERIT THE ROOM
        }
      }
    }



    console.log("Description generated:", description);

    // 3. Convert that description into a Vector (Embedding)
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: description
      })
    });

    const embeddingData = await embeddingResponse.json();
    const vector = embeddingData.data[0].embedding;

    // 4. Update the Database Row with the new info
    const { error } = await supabase
      .from('scans')
      .update({
        description: description,
        room_label: finalRoom,
        detected_objects: objects,
        embedding: vector
      })
      .eq('id', record.id);

    if (error) throw error;

    return new Response("Success: Image Analyzed", { status: 200 });

  } catch (err) {
    console.error(err);
    return new Response("Error processing image", { status: 500 });
  }
});