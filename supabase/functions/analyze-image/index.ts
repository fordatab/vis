import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
const REPLICATE_API_TOKEN = Deno.env.get('REPLICATE_API_TOKEN');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

Deno.serve(async (req) => {
  try {
    console.log("=== analyze-image function invoked ===");
    const payload = await req.json();
    console.log("Payload received:", JSON.stringify(payload).substring(0, 200));
    const record = payload.record;

    if (!record.image_url) {
      console.log("No image_url in record, returning 400");
      return new Response("No image URL", { status: 400 });
    }

    console.log(`Processing Hybrid Analysis: ${record.id}, image_url: ${record.image_url.substring(0, 80)}...`);
    console.log("OPENAI_API_KEY set:", !!OPENAI_API_KEY);
    console.log("REPLICATE_API_TOKEN set:", !!REPLICATE_API_TOKEN);

    // --- PARALLEL EXECUTION ---
    // We launch both GPT-4o (Context/Room) and Qwen3-VL (Objects) at the same time.

    // TASK A: GPT-4o (Room & Scene Context)
    const gptPromise = fetch('https://api.openai.com/v1/chat/completions', {
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
            content: "You are a visual inventory assistant. Analyze this image. Return a JSON object with two fields: 'room' (one of: Kitchen, Living Room, Bedroom, Bathroom, Office, Garage, Outdoors, Close-up, Unknown) and 'description' (a detailed paragraph describing location and atmosphere). Do NOT list every single small object, focus on the scene."
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze scene." },
              { type: "image_url", image_url: { url: record.image_url } }
            ]
          }
        ],
        response_format: { type: "json_object" }
      })
    }).then(r => r.json());

    // TASK B: Qwen3-VL (Object Detection via Vision-Language Model)
    const replicatePromise = fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "39e893666996acf464cff75688ad49ac95ef54e9f1c688fbc677330acc478e11", // Qwen3-VL-8B-Instruct
        input: {
            media: record.image_url,
            prompt: "List all visible objects in this image. Return ONLY a comma-separated list of object names, nothing else. Be specific and thorough - include furniture, electronics, decorations, containers, and any other items you can identify.",
            temperature: 0.3,
            max_new_tokens: 512
        }
      })
    }).then(r => r.json());

    // Await both to start
    console.log("Awaiting GPT-4o and Qwen3-VL in parallel...");
    const [gptData, replicateInit] = await Promise.all([gptPromise, replicatePromise]);

    console.log("GPT-4o response:", JSON.stringify(gptData).substring(0, 300));
    console.log("Replicate init response:", JSON.stringify(replicateInit).substring(0, 300));

    // --- PROCESS GPT RESULTS (Room Logic) ---
    const gptContent = JSON.parse(gptData.choices[0].message.content);
    console.log("GPT parsed content:", JSON.stringify(gptContent));
    let finalRoom = gptContent.room;
    const gptDescription = gptContent.description;
    console.log(`GPT result - room: ${finalRoom}, description: ${gptDescription?.substring(0, 80)}...`);

    // Room Fallback Logic (Your existing "10-minute rule")
    const ambiguousLabels = ["Unknown", "Close-up", "Surface", "Wall", "Floor", "Object"];
    
    if (ambiguousLabels.includes(finalRoom) || !finalRoom) {
      console.log("Room is ambiguous. Checking history...");
      const { data: history } = await supabase
        .from('scans')
        .select('room_label, created_at')
        .not('room_label', 'in', `(${ambiguousLabels.map(l => `"${l}"`).join(',')})`)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      
      if (history) {
        const diffMinutes = (new Date().getTime() - new Date(history.created_at).getTime()) / 1000 / 60;
        if (diffMinutes < 10) {
           console.log(`Inheriting room '${history.room_label}' (${diffMinutes.toFixed(1)}m ago).`);
           finalRoom = history.room_label;
        }
      }
    }

    // --- PROCESS QWEN3-VL RESULTS (Polling Replicate) ---
    let qwenOutput: string | null = null;

    if (!replicateInit?.urls?.get) {
      console.error("Replicate failed to start prediction:", JSON.stringify(replicateInit));
    }

    let pollUrl = replicateInit?.urls?.get;

    // Poll loop (timeout after 30s for Qwen3-VL which may take longer)
    for (let i = 0; pollUrl && i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const check = await fetch(pollUrl, {
            headers: { "Authorization": `Token ${REPLICATE_API_TOKEN}` }
        });
        const status = await check.json();
        console.log(`Qwen3-VL poll ${i + 1}: status=${status.status}`);
        if (status.status === "succeeded") {
            qwenOutput = status.output;
            console.log("Qwen3-VL succeeded:", qwenOutput?.substring(0, 300));
            break;
        } else if (status.status === "failed") {
            console.error("Qwen3-VL failed:", JSON.stringify(status));
            break;
        }
    }

    // Extract Qwen3-VL Data (returns comma-separated object list as string)
    let detectedLabels: string[] = [];
    let formattedObjects: { label: string; embedding: number[] }[] = [];

    console.log("Full Qwen3-VL output:", qwenOutput);

    if (qwenOutput && typeof qwenOutput === 'string') {
        // Parse comma-separated list of objects
        detectedLabels = qwenOutput
            .split(',')
            .map(item => item.trim().toLowerCase())
            .filter(item => item.length > 0);

        // Get unique labels to avoid duplicate embeddings
        const uniqueLabels = [...new Set(detectedLabels)];
        console.log(`Qwen3-VL detected ${uniqueLabels.length} unique objects:`, uniqueLabels.join(", "));

        // Generate embeddings for all unique object labels in a single batch API call
        if (uniqueLabels.length > 0) {
            console.log("Generating embeddings for detected objects...");
            const objectEmbeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                },
                body: JSON.stringify({
                    model: "text-embedding-3-small",
                    input: uniqueLabels
                })
            });
            const objectEmbeddingData = await objectEmbeddingResponse.json();
            console.log(`Generated ${objectEmbeddingData.data?.length} object embeddings`);

            // Create a map of label -> embedding
            const labelEmbeddingMap = new Map<string, number[]>();
            for (let i = 0; i < uniqueLabels.length; i++) {
                if (objectEmbeddingData.data?.[i]?.embedding) {
                    labelEmbeddingMap.set(uniqueLabels[i], objectEmbeddingData.data[i].embedding);
                }
            }

            // Format objects with embeddings
            formattedObjects = uniqueLabels.map(label => ({
                label,
                embedding: labelEmbeddingMap.get(label) || []
            }));
        }
    } else {
        console.log("No Qwen3-VL output available");
    }

    // --- HYBRID SYNTHESIS (The Magic Step) ---
    // We combine GPT's "Vibe" with Qwen3-VL's "Specifics" for the Vector
    const uniqueDetectedItems = [...new Set(detectedLabels)].join(", ");
    
    const combinedTextForVector = `
      Room Context: ${finalRoom}.
      Scene Description: ${gptDescription}
      Detailed Objects Visible: ${uniqueDetectedItems}
    `.trim();

    console.log("Vectorizing Combined Text:", combinedTextForVector.substring(0, 100) + "...");

    // 3. Generate Vector
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: combinedTextForVector
      })
    });
    const embeddingData = await embeddingResponse.json();
    console.log("Embedding response status:", embeddingResponse.status);
    console.log("Embedding vector length:", embeddingData.data?.[0]?.embedding?.length);

    // 4. Save to DB
    // We save GPT description for display, but Qwen3-VL objects for precision
    await supabase.from('scans').update({
        description: gptDescription, 
        room_label: finalRoom,
        detected_objects: formattedObjects, // Saves object labels from Qwen3-VL
        embedding: embeddingData.data[0].embedding
    }).eq('id', record.id);

    console.log(`=== Hybrid Analysis Complete for record ${record.id} ===`);
    return new Response("Hybrid Analysis Complete");

  } catch (err) {
    console.error("=== analyze-image ERROR ===", err);
    return new Response(JSON.stringify(err), { status: 500 });
  }
});