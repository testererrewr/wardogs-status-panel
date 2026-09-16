FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY public ./public
COPY src ./src
RUN mkdir -p /app/data /app/custom-bots && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "start"]
