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
            content: "You are a visual inventory assistant. Analyze this image. Return a JSON object with two fields: 'description' (a detailed paragraph describing location and items) and 'objects' (an array of specific item names found)."
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
    const aiContent = JSON.parse(visionData.choices[0].message.content);
    const description = aiContent.description;
    const objects = aiContent.objects;

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