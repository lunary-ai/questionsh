-- Create the accounts table
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE,
    credits NUMERIC(10, 4) NOT NULL DEFAULT 0.3,
    password_hash VARCHAR(255) NOT NULL,
    selected_model VARCHAR(255)
);

-- Create an index on the username column for faster lookups
CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);

-- Create the characters table
CREATE TABLE IF NOT EXISTS characters (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES accounts(id),
    name VARCHAR(255) NOT NULL,
    system_prompt TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (owner_id, name)
);

-- Create an index on the owner_id and name columns for faster lookups
CREATE INDEX IF NOT EXISTS idx_characters_owner_name ON characters(owner_id, name);

-- Create the game_saves table
CREATE TABLE IF NOT EXISTS game_saves (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES accounts(id),
    conversation JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id)
);

-- Create an index on the user_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_game_saves_user_id ON game_saves(user_id);

-- Grant necessary permissions (adjust as needed based on your setup)
-- GRANT ALL PRIVILEGES ON TABLE accounts, characters, game_saves TO your_database_user;