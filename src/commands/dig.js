import { InteractionResponseType, ApplicationCommandOptionType, ComponentType } from 'discord-api-types/payloads/v9';
import { VALID_TYPES } from '../utils/dns.js';
import { validateDomain, handleDig } from '../utils/dig.js';
import { editDeferred } from '../utils/discord.js';
import digRefresh from '../components/dig-refresh.js';
import digProvider from '../components/dig-provider.js';
import { captureException } from '../utils/error.js';
import providers from '../utils/providers.js';

const optionTypes = Object.freeze(VALID_TYPES.slice(0, 25)); // Discord has a limit of 25 options

export default {
    name: 'dig',
    description: 'Perform a DNS over Discord lookup',
    options: [
        {
            name: 'domain',
            description: 'The domain to lookup',
            type: ApplicationCommandOptionType.String,
            required: true,
        },
        {
            name: 'type',
            description: 'DNS record type to lookup',
            help: `Supported types:\n  ${optionTypes.join(', ')}\n\nDefaults to \`A\` records.`,
            type: ApplicationCommandOptionType.String,
            required: false,
            choices: optionTypes.map(type => ({
                name: `${type} records`,
                value: type,
            })),
        },
        {
            name: 'short',
            description: 'Display the results in short form',
            type: ApplicationCommandOptionType.Boolean,
            required: false,
        },
        {
            name: 'cdflag',
            description: 'Disable DNSSEC checking',
            type: ApplicationCommandOptionType.Boolean,
            required: false,
        },
        {
            name: 'provider',
            description: 'DNS provider to use',
            help: `Supported providers:\n  ${Object.keys(providers).join(', ')}\n\nDefaults to ${providers[0].name}.`,
            type: ApplicationCommandOptionType.String,
            required: false,
            choices: providers.map(({ name }) => ({ name, value: name })),
        },
    ],
    execute: async ({ interaction, response, wait, sentry }) => {
        // Get the raw values from Discord
        const rawDomain = ((interaction.data.options.find(opt => opt.name === 'domain') || {}).value || '').trim();
        const rawType = ((interaction.data.options.find(opt => opt.name === 'type') || {}).value || '').trim();
        const rawShort = (interaction.data.options.find(opt => opt.name === 'short') || {}).value || false;
        const rawCdflag = (interaction.data.options.find(opt => opt.name === 'cdflag') || {}).value || false;
        const rawProvider = ((interaction.data.options.find(opt => opt.name === 'provider') || {}).value || '').trim();

        // Parse domain input, return any error response
        const { domain, error } = validateDomain(rawDomain, response);
        if (error) return error;

        // Validate type, fallback to 'A'
        const type = VALID_TYPES.includes(rawType) ? rawType : 'A';

        // Validate provider, fallback to Cloudflare
        const provider = providers.find(p => p.name === rawProvider) || providers[0];

        // Do the processing after acknowledging the Discord command
        wait((async () => {
            // Run dig and get the embeds
            const opts = {
                domain,
                types: [ type ],
                options: { short: rawShort, cdflag: rawCdflag },
                provider,
            };
            const [ embed ] = await handleDig(opts, sentry);

            // Edit the original deferred response
            await editDeferred(interaction, {
                embeds: [ embed ],
                components: [
                    {
                        type: ComponentType.ActionRow,
                        components: [
                            digProvider.component(provider.name),
                        ],
                    },
                    {
                        type: ComponentType.ActionRow,
                        components: [
                            digRefresh.component,
                        ],
                    },
                ],
            });
        })().catch(err => {
            // Log any errors
            captureException(err, sentry);

            // Tell the user it errored
            editDeferred(interaction, {
                content: 'Sorry, something went wrong when processing your DNS query',
            }).catch(() => {}); // Ignore any further errors

            // Re-throw the error for Cf
            throw err;
        }));

        // Let Discord know we're working on the response
        return response({ type: InteractionResponseType.DeferredChannelMessageWithSource });
    },
};
