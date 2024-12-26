# question.sh

question.sh is an interactive AI-powered SSH service that allows users to connect and interact with various AI models through a command-line interface.

## Project Overview

This project implements a custom SSH server that:

- Authenticates users and manages sessions
- Provides access to AI models for text generation and conversation
- Supports multiple concurrent users
- Offers a room-based chat system
- Allows users to select and interact with different AI models

## Key Features

- User authentication and session management
- Real-time interaction with AI models
- Multi-user support with isolated sessions
- Model selection and management

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) runtime (v1.1.38 or later)
- Node.js and npm (for some dependencies)

### Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/your-username/question.sh.git
   cd question.sh
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

### Running the Server

To start the SSH server:

```bash
bun run index.ts
```

## Usage

1. Connect to the server using an SSH client:

   ```bash
   ssh username@hostname -p port
   ```

2. Once connected, you can:
   - Use `/help` to see available commands
   - Start conversations with the AI
   - Select models using `/model modelname`

## Development and Contribution

1. Fork the repository and create your feature branch
2. Make your changes, ensuring to follow the existing code style
3. Test your changes thoroughly
4. Create a pull request with a clear description of your changes

## Project Structure

- `index.ts`: Main entry point, sets up the SSH server
- `clientSession.ts`: Manages individual client sessions and interactions
- `database.ts`: Handles database operations
- `types.ts`: Contains TypeScript type definitions
- `utils.ts`: Utility functions

For more detailed information about the project's functionality and implementation, please refer to the source code and comments within each file.
