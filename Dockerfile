FROM node:18-alpine

ARG SHOPIFY_API_KEY
ARG VITE_SHOPIFY_EXTENSION_UID
ARG VITE_SHOPIFY_BLOCK_HANDLE=pdp-coupon
ENV SHOPIFY_API_KEY=$SHOPIFY_API_KEY
# Vite only substitutes %FOO% placeholders in index.html for VITE_-prefixed
# env vars. The App Bridge CDN <meta name="shopify-api-key"> tag depends on
# this — without it, Shopify's embedded-app auto-check fails.
ENV VITE_SHOPIFY_API_KEY=$SHOPIFY_API_KEY
ENV VITE_SHOPIFY_EXTENSION_UID=$VITE_SHOPIFY_EXTENSION_UID
ENV VITE_SHOPIFY_BLOCK_HANDLE=$VITE_SHOPIFY_BLOCK_HANDLE
EXPOSE 3000
WORKDIR /app
COPY web .
RUN npm install
RUN cd frontend && npm install && npm run build
CMD ["npm", "run", "serve"]
