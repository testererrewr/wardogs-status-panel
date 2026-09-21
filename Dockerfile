FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache rsvg-convert font-dejavu font-noto-emoji
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts
COPY public ./public
COPY src ./src
RUN mkdir -p /app/data /app/custom-bots /node-data && chown -R node:node /app /node-data
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
