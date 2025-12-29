#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

AWS_REGION="${AWS_REGION:-us-east-1}"
ECR_REPO_NAME="ecs-chat"
IMAGE_TAG="${IMAGE_TAG:-latest}"

echo "Getting AWS account ID..."
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"

echo "Logging into ECR..."
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "Building Docker image..."
docker build --platform linux/amd64 -t "${ECR_REPO_NAME}:${IMAGE_TAG}" .

echo "Tagging image..."
docker tag "${ECR_REPO_NAME}:${IMAGE_TAG}" "${ECR_REPO_URI}:${IMAGE_TAG}"

echo "Pushing image to ECR..."
docker push "${ECR_REPO_URI}:${IMAGE_TAG}"

echo "Updating ECS service to force new deployment..."
CLUSTER_NAME=$(aws ecs list-clusters --query "clusterArns[?contains(@, 'EcsChatCluster')]" --output text | head -1 | xargs -I {} basename {})

if [ -n "$CLUSTER_NAME" ]; then
    SERVICE_NAME=$(aws ecs list-services --cluster "$CLUSTER_NAME" --query "serviceArns[?contains(@, 'EcsChatService')]" --output text | head -1 | xargs -I {} basename {})
    
    if [ -n "$SERVICE_NAME" ]; then
        echo "Forcing new deployment for service: $SERVICE_NAME in cluster: $CLUSTER_NAME"
        aws ecs update-service --cluster "$CLUSTER_NAME" --service "$SERVICE_NAME" --force-new-deployment
    else
        echo "ECS service not found. Deploy the Amplify backend first."
    fi
else
    echo "ECS cluster not found. Deploy the Amplify backend first."
fi

echo ""
echo "Deployment complete!"
echo "ECR Image: ${ECR_REPO_URI}:${IMAGE_TAG}"

