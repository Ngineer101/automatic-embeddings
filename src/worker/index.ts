import { createClient } from "@supabase/supabase-js";
import { Context, Hono } from "hono";
import OpenAI from "openai";
const app = new Hono<{ Bindings: Env }>();

app.post("/api/generate-embeddings", async (c) => {

  console.log('Processing embeddings...')
  const body = await c.req.json()
  const { max_batch_size } = body

  // Initialize Supabase client
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY)

  // Read messages from the queue
  const { data: queueMessages, error: queueError } = await supabase.schema('pgmq_public' as any).rpc('read', {
    queue_name: 'response_embeddings',
    n: max_batch_size,
    sleep_seconds: 120, // 2 minutes
  })

  if (queueError) {
    console.error('Failed to read from queue:', queueError)
    throw new Error(`Failed to read from queue: ${queueError.message}`)
  }

  console.log(`Read ${queueMessages?.length || 0} messages from the queue`)
  if (!queueMessages || queueMessages.length === 0) {
    console.log('No messages found in the queue')
    return c.json({
      success: true,
      processed: 0,
      skipped: 0,
      failed: [],
      message: 'No messages found in the queue',
    })
  }

  // Track message IDs that should be deleted from the queue
  const processedMsgIds: number[] = []

  // Process each message in parallel
  await Promise.all(
    queueMessages.map(async (msg: {
      msg_id: number;
      message: { id: string; text: string }
    }) => {
      // Parse the message data
      const { id, text } = msg.message
      console.log(`Processing embedding for form response: ${id}`)

      // Generate embedding
      const embedding = await generateOpenAIEmbedding(c, text)

      // Update the form response with the embedding
      const { error: updateError } = await supabase
        .from('responses')
        .update({ embedding: embedding as any })
        .eq('id', id)

      if (updateError) {
        console.error(`Failed to update response ${id}:`, updateError)
        throw new Error(`Failed to update response: ${updateError.message}`)
      }

      // Mark as successfully processed
      processedMsgIds.push(msg.msg_id)
    })
  )

  // Delete successfully processed messages in a single operation
  if (processedMsgIds.length > 0) {
    console.log(`Deleting ${processedMsgIds.length} processed messages from the queue`)
    processedMsgIds.forEach(async (msgId) => {
      const { error: deleteError } = await supabase
        .schema('pgmq_public' as any)
        .rpc('delete', {
          queue_name: 'response_embeddings',
          message_id: msgId,
        })

      if (deleteError) {
        console.error('Failed to delete message:', deleteError)
      }
    })
  }

  return c.json({
    success: true,
  })
});

/**
 * Generates an embedding using OpenAI's text-embedding-3-small model
 */
async function generateOpenAIEmbedding(c: Context, text: string): Promise<number[]> {
  const openai = new OpenAI({ apiKey: c.env.OPENAI_API_KEY })

  console.log('Generating embedding for:', text)
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    encoding_format: 'float',
  })

  const embedding = response.data[0].embedding

  if (!embedding) {
    throw new Error('Failed to generate embedding from OpenAI')
  }

  return embedding
}

export default app;
