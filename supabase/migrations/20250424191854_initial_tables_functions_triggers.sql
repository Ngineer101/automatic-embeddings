-- Create responses table
CREATE TABLE IF NOT EXISTS public.responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  answer text NOT NULL,
  embedding vector(1536),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create HNSW index for vector search for better DB performance
CREATE INDEX IF NOT EXISTS responses_embedding_idx 
  ON responses
  USING hnsw (embedding vector_cosine_ops) 
  WITH (m = 16, ef_construction = 64);

SELECT pgmq.create('response_embeddings');

-- Create function to queue a response for embedding
CREATE OR REPLACE FUNCTION queue_response_embedding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Queue the response for embedding processing
  PERFORM pgmq.send(
    'response_embeddings', -- queue name configured in the previous step
    jsonb_build_object(
      'id', NEW.id,
      'text', NEW.answer -- the answer colum of the response
    )
  );
  
  -- Set embedding to NULL to indicate it needs processing
  IF TG_OP = 'UPDATE' AND OLD.answer IS DISTINCT FROM NEW.answer THEN
    NEW.embedding = NULL;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger to queue embeddings when responses are inserted or updated
DROP TRIGGER IF EXISTS queue_response_embedding_insert ON responses;
CREATE TRIGGER queue_response_embedding_insert
AFTER INSERT ON responses
FOR EACH ROW
EXECUTE FUNCTION queue_response_embedding();

DROP TRIGGER IF EXISTS queue_response_embedding_update ON responses;
CREATE TRIGGER queue_response_embedding_update
BEFORE UPDATE OF answer ON responses
FOR EACH ROW
WHEN (OLD.answer IS DISTINCT FROM NEW.answer)
EXECUTE FUNCTION queue_response_embedding();

-- Create scheduled job to process embedding queue with the worker endpoint
SELECT cron.schedule(
  'process-response-embeddings',
  '*/5 * * * *',  -- Run every 5 minutes
  $$
  SELECT net.http_post(
    url := 'cloudflare-worker-endpoint', -- e.g. https://automatic-embeddings.workers.dev/api/generate-embeddings
    body := '{"max_batch_size": 20}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
