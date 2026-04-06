import axios from "axios";
import nodemailer from "nodemailer";

export async function sendDiscordNotification(webhookUrl: string, message: string) {
  if (!webhookUrl) return;
  try {
    await axios.post(webhookUrl, { content: message });
  } catch (error) {
    console.error("Discord notification error:", error);
  }
}

export async function sendTelegramNotification(botToken: string, chatId: string, message: string) {
  if (!botToken || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: message,
    });
  } catch (error) {
    console.error("Telegram notification error:", error);
  }
}

export async function sendEmailNotification(user: string, pass: string, to: string, subject: string, text: string) {
  if (!user || !pass || !to) return;
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });

    await transporter.sendMail({
      from: user,
      to,
      subject,
      text,
    });
  } catch (error) {
    console.error("Email notification error:", error);
  }
}
