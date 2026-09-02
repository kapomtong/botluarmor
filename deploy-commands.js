require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('setup-panel')
    .setDescription('Send the Key System control panel (Admin only)')
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('genkey')
    .setDescription('Generate new key(s) (Admin only)')
    .setDefaultMemberPermissions(0)
    .addNumberOption((option) =>
      option
        .setName('duration')
        .setDescription('Duration in days (-1 for lifetime)')
        .setRequired(true)
    )
    .addNumberOption((option) =>
      option
        .setName('quantity')
        .setDescription('Number of keys to generate (default: 1, max: 100)')
        .setRequired(false)
    ),
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`Registering ${commands.length} slash command(s)...`);

    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log(`Registered commands to guild ${process.env.GUILD_ID} (instant).`);
    } else {
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );
      console.log('Registered global commands (can take up to 1 hour to appear).');
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();
