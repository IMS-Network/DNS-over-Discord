import { InteractionType, InteractionResponseType, MessageFlags } from 'discord-api-types/payloads/v9';
import WorkersSentry from 'workers-sentry/worker.js';
import { captureException } from './utils/error.js';
import verify from './utils/verify.js';
import Privacy from './utils/strings/privacy.js';
import Terms from './utils/strings/terms.js';
import commands from '../tmp/commands.json' assert { type: 'json' };

// Util to send a JSON response
const jsonResponse = obj => new Response(JSON.stringify(obj), {
    headers: {
        'Content-Type': 'application/json',
    },
});

// Util to send a perm redirect response
const redirectResponse = url => new Response(null, {
    status: 301,
    headers: {
        Location: url,
    },
});

// Process a Discord command interaction
const handleCommandInteraction = async ({ body, wait, sentry }) => {
    // Sentry scope
    sentry.getScope().setTransactionName(`command: ${body.data.name}`);
    sentry.getScope().setTag('command', body.data.name);

    // Locate the command data
    const commandData = commands[body.data.id];
    if (!commandData)
        return new Response(null, { status: 404 });

    try {
        // Load in the command
        const { default: command } = await import(`./commands/${commandData.file}`);

        // Execute
        return await command.execute({ interaction: body, response: jsonResponse, wait, sentry });
    } catch (err) {
        // Log any errors
        console.log(body);
        captureException(err, sentry);

        // Send an ephemeral message to the user
        return jsonResponse({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: 'An unexpected error occurred when executing the command.',
                flags: MessageFlags.Ephemeral,
            },
        });
    }
};

// Process a Discord component interaction
const handleComponentInteraction = async ({ body, wait, sentry }) => {
    // Sentry scope
    sentry.getScope().setTransactionName(`component: ${body.data.custom_id}`);
    sentry.getScope().setTag('component', body.data.custom_id);

    try {
        // Load in the component handler
        const { default: component } = await import(`./components/${body.data.custom_id}.js`);

        // Execute
        return await component.execute({ interaction: body, response: jsonResponse, wait, sentry });
    } catch (err) {
        // Handle a non-existent component
        if (err.code === 'MODULE_NOT_FOUND')
            return new Response(null, { status: 404 });

        // Log any errors
        console.log(body);
        captureException(err, sentry);

        // Send a 500
        return new Response(null, { status: 500 });
    }
};

// Process a Discord interaction POST request
const handleInteraction = async ({ request, wait, sentry }) => {
    // Get the body as text
    const bodyText = await request.text();
    sentry.setRequestBody(bodyText);

    // Verify a legitimate request
    if (!await verify(request, bodyText))
        return new Response(null, { status: 401 });

    // Work with JSON body going forward
    const body = JSON.parse(bodyText);
    sentry.setRequestBody(body);

    // Handle different interaction types
    switch (body.type) {
        // Handle a PING
        case InteractionType.Ping:
            return jsonResponse({
                type: InteractionResponseType.Pong,
            });

        // Handle a command
        case InteractionType.ApplicationCommand:
            return handleCommandInteraction({ body, wait, sentry });

        // Handle a component
        case InteractionType.MessageComponent:
            return handleComponentInteraction({ body, wait, sentry });

        // Unknown
        default:
            return new Response(null, { status: 501 });
    }
};

// Process all requests to the worker
const handleRequest = async ({ request, wait, sentry }) => {
    const url = new URL(request.url);

    // Send interactions off to their own handler
    if (request.method === 'POST' && url.pathname === '/interactions')
        return await handleInteraction({ request, wait, sentry });

    // Otherwise, we only care for GET requests
    if (request.method !== 'GET')
        return new Response(null, { status: 404 });

    // Health check route
    if (url.pathname === '/health')
        return new Response('OK', {
            headers: {
                'Content-Type': 'text/plain',
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                Expires: '0',
                'Surrogate-Control': 'no-store',
            },
        });

    // Privacy notice route
    if (url.pathname === '/privacy')
        return new Response(Privacy, {
            headers: {
                'Content-Type': 'text/plain',
            },
        });

    // Terms notice route
    if (url.pathname === '/terms')
        return new Response(Terms, {
            headers: {
                'Content-Type': 'text/plain',
            },
        });

    // Invite redirect
    if (url.pathname === '/invite')
        return redirectResponse(`https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&scope=applications.commands`);

    // Discord redirect
    if (url.pathname === '/server')
        return redirectResponse('https://discord.gg/JgxVfGn');

    // GitHub redirect
    if (url.pathname === '/github')
        return redirectResponse('https://github.com/MattIPv4/DNS-over-Discord');

    // Docs redirect
    if (url.pathname === '/')
        return redirectResponse('https://developers.cloudflare.com/1.1.1.1/other-ways-to-use-1.1.1.1/dns-over-discord');

    // Not found
    return new Response(null, { status: 404 });
};

// Register the worker listener
addEventListener('fetch', event => {
    // Start Sentry
    const sentry = new WorkersSentry(event, process.env.SENTRY_DSN);

    // Monkey-patch transaction name support
    // TODO: Remove once https://github.com/robertcepa/toucan-js/issues/109 is resolved
    const scopeProto = Object.getPrototypeOf(sentry.getScope());
    scopeProto.setTransactionName = function (name) {
        this.adapter.setTransactionName(name);
    };
    const adapterProto = Object.getPrototypeOf(sentry.getScope().adapter);
    const apply = adapterProto.applyToEventSync;
    adapterProto.applyToEventSync = function (event) {
        const applied = apply.call(this, event);
        if (this._transactionName) applied.transaction = this._transactionName;
        return applied;
    };

    // Process the event
    return event.respondWith(handleRequest({
        request: event.request,
        wait: event.waitUntil.bind(event),
        sentry,
    }).catch(err => {
        // Log any errors
        captureException(err, sentry);

        // Re-throw the error for Cf
        throw err;
    }));
});

