
require("dotenv").config();

const http = require("node:http");
const {
    Client,
    GatewayIntentBits,
    PermissionsBitField,
    EmbedBuilder,
    SlashCommandBuilder,
    REST,
    Routes
} = require("discord.js");

const P = PermissionsBitField.Flags;

// ================================================
// 大山県｜管理者Bot 完全版
// Render無料Web Service対応
// ================================================

const PORT = Number(process.env.PORT) || 3000;

const CONFIG = {
    spamLimit: 5,           // 5秒以内に5回で検知
    spamWindow: 5000,
    duplicateLimit: 3,      // 同じ文章を3回で検知
    duplicateWindow: 10000,
    maxMentions: 5,

    // 実際に禁止したい語句に変更してください
    blockedWords: [
        "禁止ワード1",
        "禁止ワード2",
        "禁止ワード3"
    ],

    // trueにすると管理権限を持つメンバーは
    // 自動モデレーションの対象外
    exemptManageMessages: true
};

// HTTPサーバー
const server = http.createServer((req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end("Ooyama Discord Bot is running.\n");
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`[HTTP] ポート ${PORT} で起動しました`);
});

// Discordクライアント
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// メモリ保存。再起動すると消えます。
const userMessages = new Map();
const duplicateMessages = new Map();
const warningHistory = new Map();
const automodSettings = new Map();

function normalize(value) {
    return String(value || "")
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

function safeText(value, max = 1000) {
    return String(value || "なし")
        .replace(/@/g, "@\u200b")
        .slice(0, max);
}

function isSampleWord(word) {
    return /^禁止ワード\d+$/.test(normalize(word));
}

// ================================================
// ログ
// ================================================

async function sendLog(guild, title, fields, color = 0x3498DB) {
    const channelId = process.env.LOG_CHANNEL_ID;
    if (!channelId || !guild) return;

    const channel = await guild.channels
        .fetch(channelId)
        .catch(() => null);

    if (!channel || !channel.isTextBased()) {
        console.warn("[ログ] ログチャンネルが見つかりません");
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(color)
        .addFields(fields)
        .setTimestamp();

    await channel.send({
        embeds: [embed],
        allowedMentions: { parse: [] }
    }).catch(console.error);
}

async function sendModerationLog(message, reason, content) {
    await sendLog(
        message.guild,
        "🛡️ 自動モデレーション",
        [
            {
                name: "ユーザー",
                value: `${safeText(message.author.tag, 100)}\nID: ${message.author.id}`
            },
            {
                name: "チャンネル",
                value: `<#${message.channel.id}>`
            },
            {
                name: "検知理由",
                value: safeText(reason, 500)
            },
            {
                name: "削除された文章",
                value: safeText(content, 1000)
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
    const key =
        `${message.guild.id}:${message.channel.id}:${message.author.id}`;

    let times = userMessages.get(key) || [];
    times = times.filter(time => now - time < CONFIG.spamWindow);
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
            time => now - time < CONFIG.duplicateWindow
        );
        duplicates.push(now);
        duplicateMessages.set(duplicateKey, duplicates);

        if (duplicates.length >= CONFIG.duplicateLimit) {
            return "同じ文章の連続投稿";
        }
    }

    const mentionCount =
        message.mentions.users.size +
        message.mentions.roles.size;

    if (mentionCount >= CONFIG.maxMentions) {
        return "大量メンション";
    }

    return null;
}

function detectBlockedWord(message) {
    const content = normalize(message.content);
    if (!content) return null;

    for (const word of CONFIG.blockedWords) {
        const blocked = normalize(word);

        if (!blocked || isSampleWord(word)) continue;

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
        .setDescription("Botの稼働状態を確認"),

    new SlashCommandBuilder()
        .setName("ban")
        .setDescription("メンバーをBAN")
        .setDefaultMemberPermissions(P.BanMembers)
        .addUserOption(o =>
            o.setName("user")
                .setDescription("BANするメンバー")
                .setRequired(true))
        .addStringOption(o =>
            o.setName("reason")
                .setDescription("処分理由")
                .setMaxLength(500)
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName("kick")
        .setDescription("メンバーをキック")
        .setDefaultMemberPermissions(P.KickMembers)
        .addUserOption(o =>
            o.setName("user")
                .setDescription("キックするメンバー")
                .setRequired(true))
        .addStringOption(o =>
            o.setName("reason")
                .setDescription("処分理由")
                .setMaxLength(500)
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName("clear")
        .setDescription("メッセージを一括削除")
        .setDefaultMemberPermissions(P.ManageMessages)
        .addIntegerOption(o =>
            o.setName("count")
                .setDescription("削除件数（1～100）")
                .setMinValue(1)
                .setMaxValue(100)
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName("warn")
        .setDescription("メンバーに警告を記録")
        .setDefaultMemberPermissions(P.ModerateMembers)
        .addUserOption(o =>
            o.setName("user")
                .setDescription("警告対象")
                .setRequired(true))
        .addStringOption(o =>
            o.setName("reason")
                .setDescription("警告理由")
                .setMaxLength(500)
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName("warnings")
        .setDescription("メンバーの警告履歴を確認")
        .setDefaultMemberPermissions(P.ModerateMembers)
        .addUserOption(o =>
            o.setName("user")
                .setDescription("確認対象")
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName("automod")
        .setDescription("自動モデレーションを管理")
        .setDefaultMemberPermissions(P.ManageGuild)
        .addStringOption(o =>
            o.setName("action")
                .setDescription("操作")
                .setRequired(true)
                .addChoices(
                    { name: "状態確認", value: "status" },
                    { name: "ONにする", value: "on" },
                    { name: "OFFにする", value: "off" }
                ))
].map(command => command.toJSON());

// ================================================
// スラッシュコマンド処理
// ================================================

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.guild) {
        return interaction.reply({
            content: "サーバー内で使用してください。",
            ephemeral: true
        }).catch(() => {});
    }

    const { commandName, guild, user } = interaction;

    try {
        if (commandName === "ping") {
            return interaction.reply({
                content: `🏓 Pong!\nWebSocket Ping: ${client.ws.ping}ms`,
                ephemeral: true
            });
        }

        // ---------------- BAN ----------------
        if (commandName === "ban") {
            if (!hasPermission(interaction, P.BanMembers)) {
                return interaction.reply({
                    content: "BAN権限がありません。",
                    ephemeral: true
                });
            }

            const target = interaction.options.getUser("user");
            const reason =
                interaction.options.getString("reason") || "理由未指定";

            if (
                target.id === user.id ||
                target.id === client.user.id
            ) {
                return interaction.reply({
                    content: "自分自身やBot自身はBANできません。",
                    ephemeral: true
                });
            }

            const member = await guild.members
                .fetch(target.id)
                .catch(() => null);

            if (!member) {
                return interaction.reply({
                    content: "対象メンバーがサーバーにいません。",
                    ephemeral: true
                });
            }

            if (!member.bannable) {
                return interaction.reply({
                    content: "BANできません。Botの権限とロール順位を確認してください。",
                    ephemeral: true
                });
            }

            await member.ban({
                reason: `${reason} | 実行者ID: ${user.id}`
            });

            await sendLog(guild, "🔨 BAN", [
                {
                    name: "対象",
                    value: `${safeText(target.tag, 100)} (${target.id})`
                },
                {
                    name: "実行者",
                    value: `${safeText(user.tag, 100)} (${user.id})`
                },
                { name: "理由", value: safeText(reason, 500) }
            ], 0xE74C3C);

            return interaction.reply({
                content: `🔨 ${safeText(target.tag, 100)} をBANしました。\n理由：${safeText(reason, 500)}`,
                ephemeral: true
            });
        }

        // ---------------- KICK ----------------
        if (commandName === "kick") {
            if (!hasPermission(interaction, P.KickMembers)) {
                return interaction.reply({
                    content: "キック権限がありません。",
                    ephemeral: true
                });
            }

            const target = interaction.options.getUser("user");
            const reason =
                interaction.options.getString("reason") || "理由未指定";

            if (
                target.id === user.id ||
                target.id === client.user.id
            ) {
                return interaction.reply({
                    content: "自分自身やBot自身はキックできません。",
                    ephemeral: true
                });
            }

            const member = await guild.members
                .fetch(target.id)
                .catch(() => null);

            if (!member || !member.kickable) {
                return interaction.reply({
                    content: "キックできません。対象者やBotのロール順位を確認してください。",
                    ephemeral: true
                });
            }

            await member.kick(`${reason} | 実行者ID: ${user.id}`);

            await sendLog(guild, "👢 KICK", [
                {
                    name: "対象",
                    value: `${safeText(target.tag, 100)} (${target.id})`
                },
                {
                    name: "実行者",
                    value: `${safeText(user.tag, 100)} (${user.id})`
                },
                { name: "理由", value: safeText(reason, 500) }
            ], 0xE67E22);

            return interaction.reply({
                content: `👢 ${safeText(target.tag, 100)} をキックしました。\n理由：${safeText(reason, 500)}`,
                ephemeral: true
            });
        }

        // ---------------- CLEAR ----------------
        if (commandName === "clear") {
            if (!hasPermission(interaction, P.ManageMessages)) {
                return interaction.reply({
                    content: "メッセージ管理権限がありません。",
                    ephemeral: true
                });
            }

            if (!interaction.channel?.bulkDelete) {
                return interaction.reply({
                    content: "このチャンネルでは一括削除できません。",
                    ephemeral: true
                });
            }

            const count = interaction.options.getInteger("count");

            await interaction.deferReply({ ephemeral: true });

            const messages = await interaction.channel.bulkDelete(
                count,
                true
            );

            await sendLog(guild, "🧹 一括削除", [
                {
                    name: "実行者",
                    value: `${safeText(user.tag, 100)} (${user.id})`
                },
                {
                    name: "チャンネル",
                    value: `<#${interaction.channel.id}>`
                },
                { name: "指定件数", value: String(count) },
                { name: "削除件数", value: String(messages.size) }
            ]);

            return interaction.editReply(
                `🧹 ${messages.size}件を削除しました。\n14日より古いメッセージは一括削除の対象外です。`
            );
        }

        // ---------------- WARN ----------------
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

            list.push({
                reason,
                moderator: user.tag,
                moderatorId: user.id,
                timestamp: new Date().toISOString()
            });

            warningHistory.set(key, list);

            await sendLog(guild, "⚠️ 警告記録", [
                {
                    name: "対象",
                    value: `${safeText(target.tag, 100)} (${target.id})`
                },
                {
                    name: "実行者",
                    value: `${safeText(user.tag, 100)} (${user.id})`
                },
                { name: "理由", value: safeText(reason, 500) },
                { name: "記録数", value: String(list.length) }
            ], 0xF1C40F);

            return interaction.reply({
                content: `⚠️ ${safeText(target.tag, 100)} に警告を記録しました。\n理由：${safeText(reason, 500)}\n記録数：${list.length}`,
                ephemeral: true
            });
        }

        // ---------------- WARNINGS ----------------
        if (commandName === "warnings") {
            if (!hasPermission(interaction, P.ModerateMembers)) {
                return interaction.reply({
                    content: "メンバー管理権限がありません。",
                    ephemeral: true
                });
            }

            const target = interaction.options.getUser("user");
            const list =
                warningHistory.get(`${guild.id}:${target.id}`) || [];

            if (list.length === 0) {
                return interaction.reply({
                    content: `${safeText(target.tag, 100)} の警告記録はありません。再起動後の場合、以前の記録は消えている可能性があります。`,
                    ephemeral: true
                });
            }

            const description = list.slice(-10).map((entry, index) =>
                `**${index + 1}. ${safeText(entry.reason, 400)}**\n` +
                `実行者：${safeText(entry.moderator, 100)}\n` +
                `日時：${entry.timestamp}`
            ).join("\n\n");

            const embed = new EmbedBuilder()
                .setTitle(`📋 ${safeText(target.tag, 100)} の警告履歴`)
                .setDescription(description.slice(0, 4000))
                .setColor(0xF1C40F);

            return interaction.reply({
                embeds: [embed],
                ephemeral: true
            });
        }

        // ---------------- AUTOMOD ----------------
        if (commandName === "automod") {
            if (!hasPermission(interaction, P.ManageGuild)) {
                return interaction.reply({
                    content: "サーバー管理権限がありません。",
                    ephemeral: true
                });
            }

            const action = interaction.options.getString("action");

            if (action === "on") {
                automodSettings.set(guild.id, true);
            } else if (action === "off") {
                automodSettings.set(guild.id, false);
            }

            const enabled = automodEnabled(guild.id);

            await sendLog(guild, "⚙️ 自動監視設定", [
                {
                    name: "実行者",
                    value: `${safeText(user.tag, 100)} (${user.id})`
                },
                { name: "操作", value: action },
                { name: "現在の状態", value: enabled ? "ON" : "OFF" }
            ]);

            return interaction.reply({
                content: `🛡️ 自動モデレーション：${enabled ? "ON" : "OFF"}\n※設定はBotの再起動で初期状態に戻ります。`,
                ephemeral: true
            });
        }
    } catch (error) {
        console.error(`/${commandName} エラー:`, error);

        const reply = {
            content: "コマンドに失敗しました。Botの権限、ロール順位、Renderのログを確認してください。",
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

        if (
            CONFIG.exemptManageMessages &&
            message.member?.permissions.has(P.ManageMessages)
        ) {
            return;
        }

        // 禁止ワードを優先して検知
        const reason =
            detectBlockedWord(message) ||
            detectSpam(message);

        if (!reason) return;

        const originalContent = message.content || "本文なし";

        await message.delete();

        console.log(
            `[自動削除] ${message.author.tag} (${message.author.id}): ${reason}`
        );

        await sendModerationLog(message, reason, originalContent);
    } catch (error) {
        // 削除権限がない場合など
        console.error("[自動モデレーションエラー]", error);
    }
});

// ================================================
// 起動・スラッシュコマンド登録
// ================================================

client.once("ready", async () => {
    console.log(`[大山県Bot] Discord接続成功: ${client.user.tag}`);

    const token = process.env.DISCORD_TOKEN;
    const clientId = process.env.CLIENT_ID;
    const guildId = process.env.GUILD_ID;

    if (!token || !clientId || !guildId) {
        console.error(
            "環境変数 DISCORD_TOKEN / CLIENT_ID / GUILD_ID が必要です。"
        );
        return;
    }

    try {
        const rest = new REST({ version: "10" }).setToken(token);

        await rest.put(
            Routes.applicationGuildCommands(clientId, guildId),
            { body: commands }
        );

        console.log(
            `[大山県Bot] ${commands.length}個のスラッシュコマンド登録完了`
        );
    } catch (error) {
        console.error("[スラッシュコマンド登録エラー]", error);
    }
});

client.on("error", error => {
    console.error("[Discord Client Error]", error);
});

process.on("unhandledRejection", error => {
    console.error("[Unhandled Rejection]", error);
});

if (!process.env.DISCORD_TOKEN) {
    console.error("DISCORD_TOKEN が設定されていません。");
} else {
    client.login(process.env.DISCORD_TOKEN).catch(error => {
        console.error("[Discordログイン失敗]", error);
    });
}
