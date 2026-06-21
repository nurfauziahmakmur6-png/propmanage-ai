/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Keep native/binary deps out of the webpack bundle so route handlers can require
    // them at runtime. onnxruntime-node ships a .node binary that webpack cannot parse.
    serverComponentsExternalPackages: [
      "@neondatabase/serverless",
      "@huggingface/transformers",
      "onnxruntime-node",
    ],
  },
};

export default nextConfig;
