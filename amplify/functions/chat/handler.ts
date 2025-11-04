import { Schema } from "../../data/resource";

export const handler: Schema["chat"]["functionHandler"] = async (event) => {
  const { messages } = event.arguments;
  console.log(messages);
  return "Hello, World!";
};
