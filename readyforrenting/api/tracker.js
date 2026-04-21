const https = require('https');
const crypto = require('crypto');

// Environment variables
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_TRACKER_PROPERTIES_DB_ID = process.env.NOTION_TRACKER_PROPERTIES_DB_ID;
const NOTION_TRACKER_CERTS_DB_ID = process.env.NOTION_TRACKER_CERTS_DB_ID;

// Notion API version
const NOTION_VERSION = '2022-06-28';

// Certificate types
const CERT_TYPES = ['Gas Safety', 'EICR', 'EPC', 'HMO Licence', 'Smoke & CO Alarms'];

/**
 * Parse query parameters from URL
 */
function parseQuery(queryString) {
    const query = {};
    if (queryString) {
        queryString.split('&').forEach(pair => {
            const [key, value] = pair.split('=');
            query[decodeURIComponent(key)] = decodeURIComponent(value || '');
        });
    }
    return query;
}

/**
 * Make HTTPS request
 */
function makeHttpsRequest(method, host, path, headers, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: host,
            port: 443,
            path: path,
            method: method,
            headers: {
                ...headers,
                'Content-Type': 'application/json',
                'User-Agent': 'Ready-for-Renting-Tracker'
            }
        };

        if (body) {
            options.headers['Content-Length'] = Buffer.byteLength(body);
        }

        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const responseBody = data ? JSON.parse(data) : null;
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: responseBody,
                        rawBody: data
                    });
                } catch (err) {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: null,
                        rawBody: data,
                        error: 'Failed to parse response'
                    });
                }
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(body);
        }

        req.end();
    });
}

/**
 * Validate Stripe session and get customer email
 */
async function validateSession(sessionId) {
    const path = `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`;
    const auth = Buffer.from(`${STRIPE_SECRET_KEY}:`).toString('base64');

    const response = await makeHttpsRequest('GET', 'api.stripe.com', path, {
        'Authorization': `Basic ${auth}`
    });

    if (response.statusCode !== 200) {
        throw new Error('Invalid session');
    }

    const session = response.body;

    // Check if payment is completed
    if (session.payment_status !== 'paid') {
        throw new Error('Payment not completed');
    }

    // Check if subscription is tracker
    if (!session.metadata || session.metadata.product !== 'tracker') {
        throw new Error('Invalid subscription type');
    }

    if (!session.customer_email && !session.customer_details?.email) {
        throw new Error('No email associated with session');
    }

    return {
        email: session.customer_email || session.customer_details.email,
        customerId: session.customer
    };
}

/**
 * Generate UUID v4
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Query Notion database
 */
async function queryNotion(databaseId, filter = null) {
    const path = `/v1/databases/${encodeURIComponent(databaseId)}/query`;

    const body = JSON.stringify({
        filter: filter || undefined
    });

    const response = await makeHttpsRequest('POST', 'api.notion.com', path, {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': NOTION_VERSION
    }, body);

    if (response.statusCode !== 200) {
        throw new Error(`Notion query failed: ${response.statusCode}`);
    }

    return response.body.results || [];
}

/**
 * Create a page in Notion
 */
async function createPage(databaseId, properties) {
    const path = '/v1/pages';

    const body = JSON.stringify({
        parent: { database_id: databaseId },
        properties: properties
    });

    const response = await makeHttpsRequest('POST', 'api.notion.com', path, {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': NOTION_VERSION
    }, body);

    if (response.statusCode !== 200) {
        throw new Error(`Failed to create page: ${response.statusCode}`);
    }

    return response.body;
}

/**
 * Update a page in Notion
 */
async function updatePage(pageId, properties) {
    const path = `/v1/pages/${encodeURIComponent(pageId)}`;

    const body = JSON.stringify({
        properties: properties
    });

    const response = await makeHttpsRequest('PATCH', 'api.notion.com', path, {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': NOTION_VERSION
    }, body);

    if (response.statusCode !== 200) {
        throw new Error(`Failed to update page: ${response.statusCode}`);
    }

    return response.body;
}

/**
 * Delete a page in Notion (archive it)
 */
async function deletePage(pageId) {
    const path = `/v1/pages/${encodeURIComponent(pageId)}`;

    const body = JSON.stringify({
        archived: true
    });

    const response = await makeHttpsRequest('PATCH', 'api.notion.com', path, {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': NOTION_VERSION
    }, body);

    if (response.statusCode !== 200) {
        throw new Error(`Failed to delete page: ${response.statusCode}`);
    }

    return response.body;
}

/**
 * Extract property data from Notion page
 */
function extractPropertyData(page) {
    const props = page.properties;

    return {
        pageId: page.id,
        propertyId: props.PropertyID?.rich_text?.[0]?.plain_text || '',
        email: props.Email?.rich_text?.[0]?.plain_text || '',
        address: props.Address?.rich_text?.[0]?.plain_text || '',
        postcode: props.Postcode?.rich_text?.[0]?.plain_text || '',
        created: props.Created?.date?.start || null
    };
}

/**
 * Extract certificate data from Notion page
 */
function extractCertData(page) {
    const props = page.properties;

    return {
        pageId: page.id,
        propertyId: props.PropertyID?.title?.[0]?.plain_text || '',
        type: props.CertType?.select?.name || '',
        expiryDate: props.ExpiryDate?.date?.start || null,
        lastUpdated: props.LastUpdated?.date?.start || null
    };
}

/**
 * Get all properties and certificates for user
 */
async function getProperties(email) {
    // Query properties database filtered by email
    const propertyPages = await queryNotion(NOTION_TRACKER_PROPERTIES_DB_ID, {
        property: 'Email',
        rich_text: {
            equals: email
        }
    });

    const properties = propertyPages.map(extractPropertyData);

    // For each property, query certificates
    for (const prop of properties) {
        const certPages = await queryNotion(NOTION_TRACKER_CERTS_DB_ID, {
            property: 'PropertyID',
            title: {
                equals: prop.propertyId
            }
        });

        prop.certificates = certPages.map(extractCertData);
    }

    return properties;
}

/**
 * Add a new property
 */
async function addProperty(email, address, postcode, certs = []) {
    const propertyId = generateUUID();

    // Create property in database
    const propPage = await createPage(NOTION_TRACKER_PROPERTIES_DB_ID, {
        Email: {
            rich_text: [{ text: { content: email } }]
        },
        Address: {
            rich_text: [{ text: { content: address } }]
        },
        Postcode: {
            rich_text: [{ text: { content: postcode } }]
        },
        PropertyID: {
            rich_text: [{ text: { content: propertyId } }]
        },
        Created: {
            date: {
                start: new Date().toISOString().split('T')[0]
            }
        }
    });

    // Create certificates
    const certificates = [];
    for (const cert of certs) {
        const certPage = await createPage(NOTION_TRACKER_CERTS_DB_ID, {
            PropertyID: {
                title: [{ text: { content: propertyId } }]
            },
            CertType: {
                select: {
                    name: cert.type
                }
            },
            ExpiryDate: {
                date: {
                    start: cert.expiry
                }
            },
            LastUpdated: {
                date: {
                    start: new Date().toISOString().split('T')[0]
                }
            },
            Email: {
                rich_text: [{ text: { content: email } }]
            }
        });

        certificates.push(extractCertData(certPage));
    }

    return {
        pageId: propPage.id,
        propertyId: propertyId,
        email: email,
        address: address,
        postcode: postcode,
        certificates: certificates
    };
}

/**
 * Update property and/or certificates
 */
async function updateProperty(propertyId, email, address = null, postcode = null, certs = []) {
    // Find property page
    const propertyPages = await queryNotion(NOTION_TRACKER_PROPERTIES_DB_ID, {
        property: 'PropertyID',
        rich_text: {
            equals: propertyId
        }
    });

    if (propertyPages.length === 0) {
        throw new Error('Property not found');
    }

    const propPage = propertyPages[0];

    // Update property details if provided
    if (address !== null || postcode !== null) {
        const updates = {};
        if (address !== null) {
            updates.Address = {
                rich_text: [{ text: { content: address } }]
            };
        }
        if (postcode !== null) {
            updates.Postcode = {
                rich_text: [{ text: { content: postcode } }]
            };
        }
        await updatePage(propPage.id, updates);
    }

    // Update certificates
    const certificates = [];

    if (certs.length > 0) {
        // Get existing certs for this property
        const existingCerts = await queryNotion(NOTION_TRACKER_CERTS_DB_ID, {
            property: 'PropertyID',
            title: {
                equals: propertyId
            }
        });

        const existingCertMap = {};
        existingCerts.forEach(cert => {
            const data = extractCertData(cert);
            if (data.type) {
                existingCertMap[data.type] = cert;
            }
        });

        // Update or create certificates
        for (const cert of certs) {
            if (existingCertMap[cert.type]) {
                // Update existing
                const updatedPage = await updatePage(existingCertMap[cert.type].id, {
                    ExpiryDate: {
                        date: {
                            start: cert.expiry
                        }
                    },
                    LastUpdated: {
                        date: {
                            start: new Date().toISOString().split('T')[0]
                        }
                    }
                });
                certificates.push(extractCertData(updatedPage));
            } else {
                // Create new
                const newPage = await createPage(NOTION_TRACKER_CERTS_DB_ID, {
                    PropertyID: {
                        title: [{ text: { content: propertyId } }]
                    },
                    CertType: {
                        select: {
                            name: cert.type
                        }
                    },
                    ExpiryDate: {
                        date: {
                            start: cert.expiry
                        }
                    },
                    LastUpdated: {
                        date: {
                            start: new Date().toISOString().split('T')[0]
                        }
                    },
                    Email: {
                        rich_text: [{ text: { content: email } }]
                    }
                });
                certificates.push(extractCertData(newPage));
            }
        }
    }

    // Fetch updated property with all certs
    const updatedProperties = await getProperties(email);
    return updatedProperties.find(p => p.propertyId === propertyId);
}

/**
 * Delete property and all its certificates
 */
async function deleteProperty(propertyId, email) {
    // Find and delete property
    const propertyPages = await queryNotion(NOTION_TRACKER_PROPERTIES_DB_ID, {
        property: 'PropertyID',
        rich_text: {
            equals: propertyId
        }
    });

    if (propertyPages.length > 0) {
        await deletePage(propertyPages[0].id);
    }

    // Find and delete all certificates for this property
    const certPages = await queryNotion(NOTION_TRACKER_CERTS_DB_ID, {
        property: 'PropertyID',
        title: {
            equals: propertyId
        }
    });

    for (const cert of certPages) {
        await deletePage(cert.id);
    }
}

/**
 * Main handler
 */
module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token,X-Requested-With,Accept,Accept-Version,Content-Length,Content-MD5,Content-Type,Date,X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        // Parse query parameters
        const query = parseQuery(req.url.split('?')[1]);
        const sessionId = query.session_id;
        const propertyId = query.property_id;

        if (!sessionId) {
            return res.status(400).json({ error: 'Missing session_id' });
        }

        // Validate session and get email
        let userEmail;
        try {
            const session = await validateSession(sessionId);
            userEmail = session.email;
        } catch (err) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        // Parse request body
        let body = {};
        if (req.method !== 'GET' && req.method !== 'DELETE') {
            body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        }

        // Route handlers
        if (req.method === 'GET') {
            // Get all properties and certificates
            const properties = await getProperties(userEmail);
            return res.status(200).json({ properties });

        } else if (req.method === 'POST') {
            // Add new property
            if (!body.address || !body.postcode) {
                return res.status(400).json({ error: 'Missing address or postcode' });
            }

            const property = await addProperty(
                userEmail,
                body.address,
                body.postcode,
                body.certs || []
            );

            return res.status(201).json({ property });

        } else if (req.method === 'PUT') {
            // Update property and/or certificates
            if (!propertyId) {
                return res.status(400).json({ error: 'Missing property_id' });
            }

            const property = await updateProperty(
                propertyId,
                userEmail,
                body.address || null,
                body.postcode || null,
                body.certs || []
            );

            return res.status(200).json({ property });

        } else if (req.method === 'DELETE') {
            // Delete property
            if (!propertyId) {
                return res.status(400).json({ error: 'Missing property_id' });
            }

            await deleteProperty(propertyId, userEmail);
            return res.status(200).json({ success: true });

        } else {
            return res.status(405).json({ error: 'Method not allowed' });
        }

    } catch (err) {
        console.error('Tracker API error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};
