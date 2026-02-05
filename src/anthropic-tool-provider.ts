/**
 * Anthropic LLM Provider with Native Tool Support
 *
 * Standalone provider for native tool calling without connectome-ts dependency.
 * When tools are provided, the API will return tool_use blocks that can
 * be executed and fed back in a loop.
 */

import Anthropic from '@anthropic-ai/sdk';

/**
 * LLM message format
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'cache';
  content: string;
  metadata?: {
    attachments?: Array<{
      contentType?: string;
      mimeType?: string;
      type?: string;
      url?: string;
      data?: string;
    }>;
  };
}

/**
 * Base LLM options
 */
export interface LLMOptions {
  modelId?: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  formatConfig?: {
    assistant?: {
      suffix?: string;
    };
  };
}

/**
 * Base LLM response
 */
export interface LLMResponse {
  content: string;
  tokensUsed?: number;
  modelId?: string;
}

/**
 * Tool schema for Anthropic's native tool API
 */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * Extended options with tools support
 */
export interface ToolLLMOptions extends LLMOptions {
  tools?: ToolSchema[];
}

/**
 * Extended response with tool call information
 */
export interface ToolLLMResponse extends LLMResponse {
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, any>;
  }>;
}

export interface AnthropicToolProviderConfig {
  apiKey: string;
  defaultModel?: string;
  defaultMaxTokens?: number;
  maxRetries?: number;
  retryDelay?: number;
}

export class AnthropicToolProvider {
  private client: Anthropic;
  private defaultModel: string;
  private defaultMaxTokens: number;
  private maxRetries: number;
  private retryDelay: number;

  constructor(config: AnthropicToolProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      defaultHeaders: {
        'anthropic-beta': 'context-1m-2025-08-07'
      }
    });
    this.defaultModel = config.defaultModel || 'claude-sonnet-4-0';
    this.defaultMaxTokens = config.defaultMaxTokens || 4096;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
  }

  async generate(messages: LLMMessage[], options?: ToolLLMOptions): Promise<ToolLLMResponse> {
    // Filter out cache markers
    const apiMessages = messages.filter(m => m.role !== 'cache');

    // Build stop sequences
    const stopSequences = [...(options?.stopSequences || [])];
    if (options?.formatConfig?.assistant?.suffix) {
      const suffix = options.formatConfig.assistant.suffix.trim();
      if (suffix && !stopSequences.includes(suffix)) {
        stopSequences.push(suffix);
      }
    }

    // Convert to Anthropic format
    const systemMessage = apiMessages.find(m => m.role === 'system')?.content || '';
    const conversationMessages = apiMessages.filter(m => m.role !== 'system');

    // Build Anthropic messages
    const anthropicMessages: Anthropic.MessageParam[] = await Promise.all(
      conversationMessages.map(async (msg) => {
        const attachments = msg.metadata?.attachments;
        const messageContent = msg.role === 'assistant' ? msg.content.trimEnd() : msg.content;

        let content: Anthropic.MessageParam['content'];

        // Handle image attachments
        if (attachments && Array.isArray(attachments) && attachments.length > 0) {
          const contentBlocks: Anthropic.MessageParam['content'] = [];

          for (const attachment of attachments) {
            const contentType = attachment.contentType || attachment.mimeType || '';
            const isImage = contentType.startsWith('image/') || attachment.type === 'image';

            if (isImage) {
              try {
                const imageUrl = attachment.url || attachment.data;
                if (!imageUrl) continue;

                let imageData: string;
                if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
                  imageData = await this.fetchImageAsBase64(imageUrl);
                } else {
                  imageData = imageUrl;
                }

                const mediaType = this.getValidatedMediaType(imageData, contentType);
                if (mediaType) {
                  contentBlocks.push({
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: mediaType,
                      data: imageData
                    }
                  } as Anthropic.ImageBlockParam);
                }
              } catch (error) {
                console.error(`[AnthropicToolProvider] Failed to process image:`, error);
              }
            }
          }

          contentBlocks.push({ type: 'text', text: messageContent } as Anthropic.TextBlockParam);
          content = contentBlocks;
        } else {
          content = messageContent;
        }

        return {
          role: msg.role as 'user' | 'assistant',
          content
        };
      })
    );

    // Build request
    const request: Anthropic.MessageCreateParams = {
      model: options?.modelId || this.defaultModel,
      max_tokens: options?.maxTokens || this.defaultMaxTokens,
      messages: anthropicMessages
    };

    if (systemMessage) {
      request.system = systemMessage;
    }

    if (options?.temperature !== undefined) {
      request.temperature = options.temperature;
    }

    if (stopSequences.length > 0) {
      request.stop_sequences = stopSequences;
    }

    if (options?.tools && options.tools.length > 0) {
      request.tools = options.tools;
    }

    console.log('[AnthropicToolProvider:generate] Starting request...');
    console.log('[AnthropicToolProvider:generate] Model:', request.model);
    console.log('[AnthropicToolProvider:generate] Message count:', anthropicMessages.length);

    // Retry logic
    let lastError: any;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[AnthropicToolProvider] Retry attempt ${attempt}/${this.maxRetries}`);
        }

        const response = await this.client.messages.create(request);

        const textContent = response.content
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('');

        const toolCalls = response.content
          .filter((block: any) => block.type === 'tool_use')
          .map((block: any) => ({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, any>
          }));

        console.log('[AnthropicToolProvider:generate] Stop reason:', response.stop_reason);

        return {
          content: textContent,
          tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
          modelId: response.model,
          stopReason: response.stop_reason as ToolLLMResponse['stopReason'],
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined
        };
      } catch (error: any) {
        lastError = error;
        console.error(`[AnthropicToolProvider] Request failed:`, error.message);

        const shouldRetry = attempt < this.maxRetries && this.isRetryableError(error);
        if (shouldRetry) {
          const delay = this.retryDelay * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        break;
      }
    }

    throw new Error(`Anthropic API error: ${lastError?.message || 'Unknown error'}`);
  }

  async sendToolResults(
    messages: LLMMessage[],
    assistantContent: Anthropic.ContentBlock[],
    toolResults: Array<{ tool_use_id: string; content: string }>,
    options?: ToolLLMOptions
  ): Promise<ToolLLMResponse> {
    const apiMessages = messages.filter(m => m.role !== 'cache');
    const systemMessage = apiMessages.find(m => m.role === 'system')?.content || '';
    const conversationMessages = apiMessages.filter(m => m.role !== 'system');

    const anthropicMessages: Anthropic.MessageParam[] = conversationMessages.map(msg => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.role === 'assistant' ? msg.content.trimEnd() : msg.content
    }));

    anthropicMessages.push({
      role: 'assistant',
      content: assistantContent
    });

    anthropicMessages.push({
      role: 'user',
      content: toolResults.map(tr => ({
        type: 'tool_result' as const,
        tool_use_id: tr.tool_use_id,
        content: tr.content
      }))
    });

    const request: Anthropic.MessageCreateParams = {
      model: options?.modelId || this.defaultModel,
      max_tokens: options?.maxTokens || this.defaultMaxTokens,
      messages: anthropicMessages
    };

    if (systemMessage) {
      request.system = systemMessage;
    }

    if (options?.temperature !== undefined) {
      request.temperature = options.temperature;
    }

    if (options?.tools && options.tools.length > 0) {
      request.tools = options.tools;
    }

    const response = await this.client.messages.create(request);

    const textContent = response.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');

    const toolCalls = response.content
      .filter((block: any) => block.type === 'tool_use')
      .map((block: any) => ({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, any>
      }));

    return {
      content: textContent,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
      modelId: response.model,
      stopReason: response.stop_reason as ToolLLMResponse['stopReason'],
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    };
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  getProviderName(): string {
    return 'anthropic-tools';
  }

  private isRetryableError(error: any): boolean {
    if (error instanceof Anthropic.APIError) {
      const retryableStatuses = [429, 500, 502, 503, 504];
      if (error.status && retryableStatuses.includes(error.status)) {
        return true;
      }
    }

    const message = (error.message || '').toLowerCase();
    return message.includes('connection') ||
           message.includes('timeout') ||
           message.includes('econnreset');
  }

  private async fetchImageAsBase64(url: string): Promise<string> {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }

    const buffer = await response.buffer();
    return buffer.toString('base64');
  }

  private getValidatedMediaType(base64Data: string, declaredContentType: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
    const detectedType = this.detectImageTypeFromBase64(base64Data);
    if (detectedType) return detectedType;

    const normalized = declaredContentType.toLowerCase();
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'image/jpeg';
    if (normalized.includes('png')) return 'image/png';
    if (normalized.includes('gif')) return 'image/gif';
    if (normalized.includes('webp')) return 'image/webp';
    return null;
  }

  private detectImageTypeFromBase64(base64Data: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
    try {
      const buffer = Buffer.from(base64Data.slice(0, 32), 'base64');

      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        return 'image/png';
      }
      if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return 'image/jpeg';
      }
      if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
        return 'image/gif';
      }
      if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
          buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
        return 'image/webp';
      }

      return null;
    } catch {
      return null;
    }
  }
}
