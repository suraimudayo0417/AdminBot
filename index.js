
require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    PermissionsBitField,
    EmbedBuilder,
    SlashCommandBuilder,
    REST,
    Routes
} = require("discord.js");

// ================================================
// 大山県｜管理者Bot
// 自動削除 + スラッシュコマンド
// ================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const P = PermissionsBitField.Flags;

const CONFIG = {
    spamLimit: 5,
    spamWindow: 5000,
    duplicateLimit: 3,
    duplicateWindow: 10000,
    maxMentions: 5,

    blockedWords: [
        "禁止ワード1",
        "禁止ワード2",
        "禁止ワード3"
    ]
};

// 再起動すると消えるメモリ保存
const userMessages = new Map();
const duplicateMessages = new Map();
const warningHistory = new Map();
const automodSettings = new Map();

function normalize(text) {
    return text
        .toLowerCase()
        .normalize("NFKC")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .trim();
}

function automodEnabled(guildId) {
    return automodSettings.get(guildId) !== false;
}

function hasPermission(interaction, permission) {
    return Boolean(interaction.memberPermissions?.has(permission));
}

// ================================================
// ログ
// ================================================

async function sendLog(guild, title, fields, color = 0x3498DB) {
    const channelId = process.env.LOG_CHANNEL_ID;
    if (!channelId) return;

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(color)
        .addFields(fields)
        .setTimestamp();

    await channel.send({ embeds: [embed] }).catch(console.error);
}

async function sendModerationLog(message, reason) {
    await sendLog(
        message.guild,
        "🛡️ 自動モデレーション",
        [
            {
                name: "ユーザー",
                value: `${message.author.tag} (${message.author.id})`
            },
            {
                name: "チャンネル",
                value: `<#${message.channel.id}>`
            },
            {
                name: "検知理由",
                value: reason
            },
            {
                name: "削除された文章",
                value: (message.content || "本文なし").slice(0, 1000)
            }
        ],
        0xE74C3C
    );
}

// ================================================
// スパム検知
// ================================================

function detectSpam(message) {
    const now = Date.now();
    const key = `${message.guild.id}:${message.channel.id}:${message.author.id}`;

    let times = userMessages.get(key) || [];
    times = times.filter(t => now - t < CONFIG.spamWindow);
    times.push(now);
    userMessages.set(key, times);

    if (times.length >= CONFIG.spamLimit) {
        return "短時間の連続投稿";
    }

    const content = normalize(message.content);

    if (content) {
        const duplicateKey = `${key}:${content}`;
        let duplicates = duplicateMessages.get(duplicateKey) || [];

        duplicates = duplicates.filter(
            t => now - t < CONFIG.duplicateWindow
        );
        duplicates.push(now);
        duplicateMessages.set(duplicateKey, duplicates);

        if (duplicates.length >= CONFIG.duplicateLimit) {
            return "同じ文章の連続投稿";
        }
    }

    const mentions =
        message.mentions.users.size +
        message.mentions.roles.size;

    if (mentions >= CONFIG.maxMentions) {
        return "大量メンション";
    }

    return null;
}

function detectBlockedWord(message) {
    const content = normalize(message.content);
    if (!content) return null;

    for (const word of CONFIG.blockedWords) {
        const blocked = normalize(word);

        // 初期設定用のサンプル文字列は判定しない
        if (!blocked || /^禁止ワード\d+$/.test(blocked)) continue;

        if (content.includes(blocked)) {
            return `禁止ワード検知: ${word}`;
        }
    }

    return null;
}

// ================================================
// スラッシュコマンド定義
// ================================================

const commands = [
    new SlashCommandBuilder()
        .setName("ping")
        .setDescription("Botの応答状態を確認"),

    new SlashCommandBuilder()
        .setName("ban")
        .setDescription("メンバーをBANする")
        .setDefaultMemberPermissions(P.BanMembers)
        .addUserOption(option =>
            option.setName("user")
                .setDescription("BANするメンバー")
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName("reason")
                .setDescription("処分理由")
                .setMaxLength(500)
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("kick")
        .setDescription("メンバーをキックする")
        .setDefaultMemberPermissions(P.KickMembers)
        .addUserOption(option =>
            option.setName("user")
                .setDescription("キックするメンバー")
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName("reason")
                .setDescription("処分理由")
                .setMaxLength(500)
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("clear")
        .setDescription("チャンネルのメッセージを一括削除")
        .setDefaultMemberPermissions(P.ManageMessages)
        .addIntegerOption(option =>
            option.setName("count")
                .setDescription("削除件数（1～100）")
                .setMinValue(1)
                .setMaxValue(100)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("warn")
        .setDescription("メンバーに警告を記録")
        .setDefaultMemberPermissions(P.ModerateMembers)
        .addUserOption(option =>
            option.setName("user")
                .setDescription("警告対象")
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName("reason")
                .setDescription("警告理由")
                .setMaxLength(500)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("warnings")
        .setDescription("メンバーの警告履歴を確認")
        .setDefaultMemberPermissions(P.ModerateMembers)
        .addUserOption(option =>
            option.setName("user")
                .setDescription("確認対象")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("automod")
        .setDescription("自動モデレーションを管理")
        .setDefaultMemberPermissions(P.ManageGuild)
        .addStringOption(option =>
            option.setName("action")
                .setDescription("操作")
                .setRequired(true)
                .addChoices(
                    { name: "状態確認", value: "status" },
                    { name: "ONにする", value: "on" },
                    { name: "OFFにする", value: "off" }
                )
        )
].map(command => command.toJSON());

// ================================================
// コマンド処理
// ================================================

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) {
        return interaction.reply({
            content: "サーバー内で使用してください。",
            ephemeral: true
        });
    }

    const { commandName, guild, user } = interaction;

    try {
        if (commandName === "ping") {
            return interaction.reply({
                content: `🏓 Pong! WebSocket Ping: ${client.ws.ping}ms`,
                ephemeral: true
            });
        }

        if (commandName === "ban") {
            if (!hasPermission(interaction, P.BanMembers)) {
                return interaction.reply({
                    content: "BAN権限がありません。",
                    ephemeral: true
                });
            }

            const target = interaction.options.getUser("user");
            const reason = interaction.options.getString("reason") || "理由未指定";

            if (target.id === user.id || target.id === client.user.id) {
                return interaction.reply({
                    content: "自分自身やBot自身はBANできません。",
                    ephemeral: true
                });
            }

            const member = await guild.members.fetch(target.id).catch(() => null);

            if (!member) {
                return interaction.reply({
                    content: "対象メンバーが見つかりません。",
                    ephemeral: true
                });
            }

            if (!member.bannable) {
                return interaction.reply({
                    content: "BANできません。Botの権限・ロール順位を確認してください。",
                    ephemeral: true
                });
            }

            await member.ban({ reason: `${reason} | 実行者: ${user.tag}` });

            await sendLog(guild, "🔨 BAN", [
                { name: "対象", value: `${target.tag} (${target.id})` },
                { name: "実行者", value: `${user.tag} (${user.id})` },
                { name: "理由", value: reason }
            ], 0xE74C3C);

            return interaction.reply({
                content: `🔨 ${target.tag} をBANしました。\n理由：${reason}`,
                ephemeral: true
            });
        }

        if (commandName === "kick") {
            if (!hasPermission(interaction, P.KickMembers)) {
                return interaction.reply({
                    content: "キック権限がありません。",
                    ephemeral: true
                });
            }

            const target = interaction.options.getUser("user");
            const reason = interaction.options.getString("reason") || "理由未指定";

            if (target.id === user.id || target.id === client.user.id) {
                return interaction.reply({
                    content: "自分自身やBot自身はキックできません。",
                    ephemeral: true
                });
            }

            const member = await guild.members.fetch(target.id).catch(() => null);

            if (!member || !member.kickable) {
                return interaction.reply({
                    content: "キックできません。対象者の存在とBotのロール順位を確認してください。",
                    ephemeral: true
                });
            }

            await member.kick(`${reason} | 実行者: ${user.tag}`);

            await sendLog(guild, "👢 KICK", [
                { name: "対象", value: `${target.tag} (${target.id})` },
                { name: "実行者", value: `${user.tag} (${user.id})` },
                { name: "理由", value: reason }
            ], 0xE67E22);

            return interaction.reply({
                content: `👢 ${target.tag} をキックしました。\n理由：${reason}`,
                ephemeral: true
            });
        }

        if (commandName === "clear") {
            if (!hasPermission(interaction, P.ManageMessages)) {
                return interaction.reply({
                    content: "メッセージ管理権限がありません。",
                    ephemeral: true
                });
            }

            const count = interaction.options.getInteger("count");

            await interaction.deferReply({ ephemeral: true });

            const messages = await interaction.channel.bulkDelete(count, true);

            await sendLog(guild, "🧹 メッセージ一括削除", [
                { name: "実行者", value: `${user.tag} (${user.id})` },
                { name: "チャンネル", value: `<#${interaction.channel.id}>` },
                { name: "指定件数", value: String(count) },
                { name: "実際の削除件数", value: String(messages.size) }
            ], 0x3498DB);

            return interaction.editReply(
                `🧹 ${messages.size}件のメッセージを削除しました。\n14日より古いメッセージは一括削除できないため対象外です。`
            );
        }

        if (commandName === "warn") {
            if (!hasPermission(interaction, P.ModerateMembers)) {
                return interaction.reply({
                    content: "メンバー管理権限がありません。",
                    ephemeral: true
                });
            }

            const target = interaction.options.getUser("user");
            const reason = interaction.options.getString("reason");

            if (target.bot) {
                return interaction.reply({
                    content: "Botには警告を記録できません。",
                    ephemeral: true
                });
            }

            const key = `${guild.id}:${target.id}`;
            const list = warningHistory.get(key) || [];

            const entry = {
                reason,
                moderator: user.tag,
                moderatorId: user.id,
                timestamp: new Date().toISOString()
            };

            list.push(entry);
            warningHistory.set(key, list);

            await sendLog(guild, "⚠️ 警告記録", [
                { name: "対象", value: `${target.tag} (${target.id})` },
                { name: "実行者", value: `${user.tag} (${user.id})` },
                { name: "理由", value: reason },
                { name: "累計（メモリ内）", value: String(list.length) }
            ], 0xF1C40F);

            return interaction.reply({
                content: `⚠️ ${target.tag} に警告を記録しました。\n理由：${reason}\n現在の記録数：${list.length}`,
                ephemeral: true
            });
        }

        if (commandName === "warnings") {
            if (!hasPermission(interaction, P.ModerateMembers)) {
                return interaction.reply({
                    content: "メンバー管理権限がありません。",
                    ephemeral: true
                });
            }

            const target = interaction.options.getUser("user");
            const list = warningHistory.get(`${guild.id}:${target.id}`) || [];

            if (list.length === 0) {
                return interaction.reply({
                    content: `📋 ${target.tag} の警告記録はありません（または再起動で消去されています）。`,
                    ephemeral: true
                });
            }

            const description = list.slice(-10).map((entry, index) =>
                `**${index + 1}. ${entry.reason}**\n` +
                `実行者：${entry.moderator}\n` +
                `日時：${entry.timestamp}`
            ).join("\n\n");

            const embed = new EmbedBuilder()
                .setTitle(`📋 ${target.tag} の警告履歴`)
                .setDescription(description.slice(0, 4000))
                .setColor(0xF1C40F);

            return interaction.reply({
                embeds: [embed],
                ephemeral: true
            });
        }

        if (commandName === "automod") {
            if (!hasPermission(interaction, P.ManageGuild)) {
                return interaction.reply({
                    content: "サーバー管理権限がありません。",
                    ephemeral: true
                });
            }

            const action = interaction.options.getString("action");

            if (action === "on") automodSettings.set(guild.id, true);
            if (action === "off") automodSettings.set(guild.id, false);

            const enabled = automodEnabled(guild.id);

            await sendLog(guild, "⚙️ 自動モデレーション設定変更", [
                { name: "実行者", value: `${user.tag} (${user.id})` },
                { name: "操作", value: action },
                { name: "現在の状態", value: enabled ? "ON" : "OFF" }
            ]);

            return interaction.reply({
                content: `🛡️ 自動モデレーション：${enabled ? "ON" : "OFF"}`,
                ephemeral: true
            });
        }
    } catch (error) {
        console.error(`/${commandName} エラー:`, error);

        const reply = {
            content: "コマンドの実行に失敗しました。Botの権限・ロール順位・ログを確認してください。",
            ephemeral: true
        };

        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(reply).catch(() => {});
        } else {
            await interaction.reply(reply).catch(() => {});
        }
    }
});

// ================================================
// 自動モデレーション
// ================================================

client.on("messageCreate", async message => {
    try {
        if (!message.guild || message.author.bot) return;
        if (!automodEnabled(message.guild.id)) return;

        // メッセージ管理権限を持つ運営は自動検知対象外
        if (message.member?.permissions.has(P.ManageMessages)) return;

        const reason =
            detectBlockedWord(message) ||
            detectSpam(message);

        if (!reason) return;

        await message.delete();
        console.log(`[自動削除] ${message.author.tag}: ${reason}`);

        await sendModerationLog(message, reason);
    } catch (error) {
        console.error("自動モデレーションエラー:", error);
    }
});

// ================================================
// 起動・スラッシュコマンド登録
// ================================================

client.once("ready", async () => {
    console.log(`[大山県Bot] 起動完了: ${client.user.tag}`);

    const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

    if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
        console.error("環境変数 DISCORD_TOKEN / CLIENT_ID / GUILD_ID を設定してください。");
        return;
    }

    try {
        const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );

        console.log("スラッシュコマンドの登録が完了しました。");
    } catch (error) {
        console.error("スラッシュコマンド登録エラー:", error);
    }
});

client.on("error", console.error);

client.login(process.env.DISCORD_TOKEN);
