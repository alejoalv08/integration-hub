# Use official Node.js lightweight image
FROM node:18-alpine

# Set working directory inside the container
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the source code
COPY . .

# Expose the port
EXPOSE 3001

# Start the server
CMD ["node", "index.js"]
