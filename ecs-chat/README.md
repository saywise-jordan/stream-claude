# ECS Chat Service

Docker container version of the streaming chat Lambda function, designed to run on AWS ECS.

## Local Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build TypeScript
npm run build

# Run production build
npm start
```

## Docker

### Build and Run Locally

```bash
# Build the image
docker build -t ecs-chat .

# Run with API key
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=your-key ecs-chat
```

### Using Docker Compose

```bash
# Set your API key
export ANTHROPIC_API_KEY=your-key

# Run
docker-compose up
```

## API

### Health Check

```
GET /health
```

Returns `{ "status": "healthy" }`

### Chat (Streaming)

```
POST /chat
Content-Type: application/json

{
  "messages": [
    { "role": "user", "content": "Hello!" }
  ],
  "simulate": false
}
```

Returns Server-Sent Events (SSE) stream with Claude responses.

## ECS Deployment

The ECS infrastructure is managed through Amplify CDK in `amplify/backend.ts`. This includes:

- VPC with public/private subnets
- ECS Fargate cluster
- ECR repository for Docker images
- Application Load Balancer
- Auto-scaling (1-4 tasks based on CPU)
- Secrets Manager integration for API key

### Prerequisites

1. Deploy the Amplify backend first:
   ```bash
   npx ampx sandbox
   # or for production
   npx ampx pipeline-deploy
   ```

2. Set your Anthropic API key in Secrets Manager:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id ecs-chat/anthropic-api-key \
     --secret-string "your-anthropic-api-key"
   ```

### Deploy Container

Use the deploy script to build and push the Docker image:

```bash
# Set AWS region if needed (default: us-east-1)
export AWS_REGION=us-east-1

# Deploy
./deploy.sh
```

The script will:
1. Log into ECR
2. Build the Docker image for linux/amd64
3. Push to ECR
4. Force a new ECS deployment

### Manual Deployment

```bash
# Get AWS account ID and ECR URI
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO_URI="${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/ecs-chat"

# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com"

# Build and push
docker build --platform linux/amd64 -t ecs-chat .
docker tag ecs-chat:latest "${ECR_REPO_URI}:latest"
docker push "${ECR_REPO_URI}:latest"
```

### Service URLs

After deployment, the service URLs are available in `amplify_outputs.json`:

- `custom.ecsChatUrl` - HTTP endpoint for SSE streaming
- `custom.ecsChatWsUrl` - WebSocket endpoint
- `custom.ecrRepositoryUri` - ECR repository URI

### Infrastructure Details

**Task Definition:**
- CPU: 256 (0.25 vCPU)
- Memory: 512 MB
- Container port: 3000

**Auto-Scaling:**
- Min tasks: 1
- Max tasks: 4
- Target CPU utilization: 70%

**ALB Configuration:**
- Internet-facing
- HTTP listener on port 80
- Health check: GET /health
- Sticky sessions enabled (1 hour)
