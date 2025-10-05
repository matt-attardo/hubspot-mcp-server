import express from 'express';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const HUBSPOT_API_BASE = "https://api.hubapi.com";

// Helper function to make HubSpot API calls
async function hubspotRequest(endpoint, options = {}) {
  const url = `${HUBSPOT_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${HUBSPOT_API_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`HubSpot API error: ${response.status} - ${error}`);
  }

  return response.json();
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'HubSpot MCP Server is running', version: '1.0.0' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// SSE endpoint for MCP
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/message', res);
  
  const server = new Server(
    {
      name: "hubspot-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Define available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "search_contacts",
          description: "Search for contacts in HubSpot by name, email, or company",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query (name, email, company, etc.)",
              },
              limit: {
                type: "number",
                description: "Maximum number of results to return (default: 10)",
                default: 10,
              },
            },
            required: ["query"],
          },
        },
        {
          name: "get_contact",
          description: "Get detailed information about a specific contact",
          inputSchema: {
            type: "object",
            properties: {
              contact_id: {
                type: "string",
                description: "HubSpot contact ID or email address",
              },
            },
            required: ["contact_id"],
          },
        },
        {
          name: "create_contact",
          description: "Create a new contact in HubSpot",
          inputSchema: {
            type: "object",
            properties: {
              email: { type: "string", description: "Contact email address" },
              firstname: { type: "string", description: "First name" },
              lastname: { type: "string", description: "Last name" },
              phone: { type: "string", description: "Phone number" },
              company: { type: "string", description: "Company name" },
            },
            required: ["email"],
          },
        },
        {
          name: "search_deals",
          description: "Search for deals in HubSpot pipeline",
          inputSchema: {
            type: "object",
            properties: {
              pipeline_stage: {
                type: "string",
                description: "Filter by pipeline stage",
              },
              limit: {
                type: "number",
                description: "Maximum number of results (default: 20)",
                default: 20,
              },
            },
          },
        },
        {
          name: "create_deal",
          description: "Create a new deal in HubSpot",
          inputSchema: {
            type: "object",
            properties: {
              dealname: { type: "string", description: "Name of the deal" },
              amount: { type: "number", description: "Deal amount in dollars" },
              dealstage: { type: "string", description: "Pipeline stage" },
              pipeline: { type: "string", description: "Pipeline name", default: "default" },
            },
            required: ["dealname", "amount", "dealstage"],
          },
        },
        {
          name: "get_pipeline_summary",
          description: "Get a summary of all deals by pipeline stage",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    };
  });

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "search_contacts": {
          const limit = args.limit || 10;
          const data = await hubspotRequest(`/crm/v3/objects/contacts/search`, {
            method: "POST",
            body: JSON.stringify({
              filterGroups: [
                {
                  filters: [
                    {
                      propertyName: "email",
                      operator: "CONTAINS_TOKEN",
                      value: args.query,
                    },
                  ],
                },
                {
                  filters: [
                    {
                      propertyName: "firstname",
                      operator: "CONTAINS_TOKEN",
                      value: args.query,
                    },
                  ],
                },
                {
                  filters: [
                    {
                      propertyName: "lastname",
                      operator: "CONTAINS_TOKEN",
                      value: args.query,
                    },
                  ],
                },
              ],
              properties: ["firstname", "lastname", "email", "phone", "company"],
              limit: limit,
            }),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(data.results, null, 2) }],
          };
        }

        case "get_contact": {
          const isEmail = args.contact_id.includes("@");
          let data;

          if (isEmail) {
            const searchData = await hubspotRequest(`/crm/v3/objects/contacts/search`, {
              method: "POST",
              body: JSON.stringify({
                filterGroups: [
                  {
                    filters: [
                      {
                        propertyName: "email",
                        operator: "EQ",
                        value: args.contact_id,
                      },
                    ],
                  },
                ],
                properties: ["firstname", "lastname", "email", "phone", "company", "lifecyclestage"],
                limit: 1,
              }),
            });
            data = searchData.results[0];
          } else {
            data = await hubspotRequest(
              `/crm/v3/objects/contacts/${args.contact_id}?properties=firstname,lastname,email,phone,company,lifecyclestage`
            );
          }

          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        }

        case "create_contact": {
          const data = await hubspotRequest(`/crm/v3/objects/contacts`, {
            method: "POST",
            body: JSON.stringify({ properties: args }),
          });
          return {
            content: [
              {
                type: "text",
                text: `Contact created successfully! ID: ${data.id}\n${JSON.stringify(data, null, 2)}`,
              },
            ],
          };
        }

        case "search_deals": {
          const limit = args.limit || 20;
          const filterGroups = [];

          if (args.pipeline_stage) {
            filterGroups.push({
              filters: [
                {
                  propertyName: "dealstage",
                  operator: "EQ",
                  value: args.pipeline_stage,
                },
              ],
            });
          }

          const data = await hubspotRequest(`/crm/v3/objects/deals/search`, {
            method: "POST",
            body: JSON.stringify({
              filterGroups: filterGroups.length > 0 ? filterGroups : undefined,
              properties: ["dealname", "amount", "dealstage", "pipeline", "closedate"],
              limit: limit,
            }),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(data.results, null, 2) }],
          };
        }

        case "create_deal": {
          const properties = {
            dealname: args.dealname,
            amount: args.amount,
            dealstage: args.dealstage,
            pipeline: args.pipeline || "default",
          };

          const data = await hubspotRequest(`/crm/v3/objects/deals`, {
            method: "POST",
            body: JSON.stringify({ properties }),
          });

          return {
            content: [
              {
                type: "text",
                text: `Deal created successfully! ID: ${data.id}\n${JSON.stringify(data, null, 2)}`,
              },
            ],
          };
        }

        case "get_pipeline_summary": {
          const data = await hubspotRequest(`/crm/v3/objects/deals/search`, {
            method: "POST",
            body: JSON.stringify({
              properties: ["dealname", "amount", "dealstage"],
              limit: 100,
            }),
          });

          const summary = {};
          let totalValue = 0;

          data.results.forEach((deal) => {
            const stage = deal.properties.dealstage || "Unknown";
            const amount = parseFloat(deal.properties.amount) || 0;

            if (!summary[stage]) {
              summary[stage] = { count: 0, totalValue: 0 };
            }

            summary[stage].count++;
            summary[stage].totalValue += amount;
            totalValue += amount;
          });

          return {
            content: [
              {
                type: "text",
                text: `Pipeline Summary:\n${JSON.stringify(
                  { summary, totalDeals: data.results.length, totalValue },
                  null,
                  2
                )}`,
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  });

  await server.connect(transport);
});

// Message endpoint for MCP
app.post('/message', express.json(), async (req, res) => {
  // This will be handled by the SSE transport
  res.json({ status: 'received' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HubSpot MCP Server running on port ${PORT}`);
});
