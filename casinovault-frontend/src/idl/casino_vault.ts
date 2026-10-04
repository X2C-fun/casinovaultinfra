/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/casino_vault.json`.
 */
export type CasinoVault = {
  "address": "DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY",
  "metadata": {
    "name": "casinoVault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Non-custodial SOL vault program used by the casino backend to hold player funds."
  },
  "instructions": [
    {
      "name": "deposit",
      "docs": [
        "Moves `amount` lamports from the signer's wallet into the pool vault."
      ],
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "depositor",
          "docs": [
            "Source of the lamports and the key the backend will credit.",
            "",
            "Anyone may deposit: players fund their balance this way and the house",
            "tops up the bankroll the same way. The signer is what identifies the",
            "depositor, so the backend can never be tricked into crediting somebody",
            "else."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "vaultState",
          "docs": [
            "Singleton state PDA. Read to enforce the pause switch."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "poolVault",
          "docs": [
            "Singleton pool vault, verified against the bump recorded at",
            "initialization."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "Creates the singleton vault state and pool vault, registering the signing",
        "admin as the withdrawal authority. Runs exactly once per deployment."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Backend authority being registered. It signs, so nobody can register an",
            "admin key they do not control, and it pays the rent for both PDAs."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "vaultState",
          "docs": [
            "Singleton state PDA, `[\"vault_state\"]`. `init` makes this instruction",
            "run exactly once for the lifetime of the program."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "poolVault",
          "docs": [
            "Singleton pool vault PDA, `[\"pool_vault\"]`. Stays system-owned and",
            "data-less so the System Program can move lamports out of it under its",
            "seed."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "setPaused",
      "docs": [
        "Suspends or resumes deposits and withdrawals. Admin only."
      ],
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Backend authority. Only the registered admin may flip the switch."
          ],
          "signer": true,
          "relations": [
            "vaultState"
          ]
        },
        {
          "name": "vaultState",
          "docs": [
            "Singleton state PDA holding the flag."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "withdraw",
      "docs": [
        "Releases `amount` lamports from the pool vault to the signing user.",
        "Requires the admin's signature."
      ],
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "user",
          "docs": [
            "Recipient of the funds.",
            "",
            "The destination is this signer and nothing else: there is no address",
            "parameter, so a stolen admin key cannot redirect a payout. The user's",
            "signature also proves the payout was requested by the account holder."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "admin",
          "docs": [
            "Backend authority. Its signature is the on-chain proof that the",
            "off-chain balance, limit and anti-cheat checks passed. A user's",
            "signature alone is never sufficient."
          ],
          "signer": true,
          "relations": [
            "vaultState"
          ]
        },
        {
          "name": "vaultState",
          "docs": [
            "Singleton state PDA. Pins the admin and enforces the pause switch."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "poolVault",
          "docs": [
            "Singleton pool vault. Signs the outgoing transfer through its seed and",
            "the bump stored in `vault_state`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "vaultState",
      "discriminator": [
        228,
        196,
        82,
        165,
        98,
        210,
        235,
        152
      ]
    }
  ],
  "events": [
    {
      "name": "depositEvent",
      "discriminator": [
        120,
        248,
        61,
        83,
        31,
        142,
        107,
        144
      ]
    },
    {
      "name": "pauseStateChangedEvent",
      "discriminator": [
        142,
        29,
        26,
        107,
        147,
        150,
        52,
        254
      ]
    },
    {
      "name": "vaultInitializedEvent",
      "discriminator": [
        203,
        214,
        91,
        5,
        185,
        248,
        192,
        149
      ]
    },
    {
      "name": "withdrawEvent",
      "discriminator": [
        22,
        9,
        133,
        26,
        160,
        44,
        71,
        192
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Unauthorized: signer is not the registered admin"
    },
    {
      "code": 6001,
      "name": "invalidAmount",
      "msg": "Invalid amount: value must be greater than zero"
    },
    {
      "code": 6002,
      "name": "insufficientFunds",
      "msg": "Insufficient funds for the requested transfer"
    },
    {
      "code": 6003,
      "name": "vaultAlreadyInitialized",
      "msg": "The vault has already been initialized"
    },
    {
      "code": 6004,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6005,
      "name": "vaultPaused",
      "msg": "The vault is paused"
    }
  ],
  "types": [
    {
      "name": "depositEvent",
      "docs": [
        "Emitted when SOL enters the pool, whether from a player or from the house."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "docs": [
              "Wallet that signed and funded the deposit. The backend credits this key."
            ],
            "type": "pubkey"
          },
          {
            "name": "amount",
            "docs": [
              "Lamports moved into the pool vault."
            ],
            "type": "u64"
          },
          {
            "name": "vaultBalance",
            "docs": [
              "Pool vault lamports after the deposit, rent reserve included."
            ],
            "type": "u64"
          },
          {
            "name": "timestamp",
            "docs": [
              "Unix timestamp of the enclosing slot."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pauseStateChangedEvent",
      "docs": [
        "Emitted whenever the admin flips the pause switch."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "docs": [
              "Admin authority that made the change."
            ],
            "type": "pubkey"
          },
          {
            "name": "paused",
            "docs": [
              "New value of the switch: `true` means deposits and withdrawals are",
              "rejected."
            ],
            "type": "bool"
          },
          {
            "name": "timestamp",
            "docs": [
              "Unix timestamp of the enclosing slot."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "vaultInitializedEvent",
      "docs": [
        "Emitted once, when the vault state and pool vault are created."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "docs": [
              "Backend authority registered as admin."
            ],
            "type": "pubkey"
          },
          {
            "name": "vaultBump",
            "docs": [
              "Canonical bump of the pool vault PDA."
            ],
            "type": "u8"
          },
          {
            "name": "rentReserve",
            "docs": [
              "Lamports parked in the pool vault to keep it rent exempt. These are not",
              "player funds and must not be credited to anybody."
            ],
            "type": "u64"
          },
          {
            "name": "timestamp",
            "docs": [
              "Unix timestamp of the enclosing slot."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "vaultState",
      "docs": [
        "Global program configuration, stored at the singleton PDA `[\"vault_state\"]`.",
        "",
        "There is no per-user state and no balance field. Every lamport sits in one",
        "shared pool vault, and who owns how much of it is the backend's business."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "docs": [
              "Backend authority that must co-sign every withdrawal and is the only",
              "key allowed to pause the program."
            ],
            "type": "pubkey"
          },
          {
            "name": "vaultBump",
            "docs": [
              "Canonical bump of the pool vault PDA (`[\"pool_vault\"]`). Persisted so",
              "that CPI signing never has to re-derive it, and never accepts a",
              "caller-supplied bump."
            ],
            "type": "u8"
          },
          {
            "name": "paused",
            "docs": [
              "Emergency switch. While set, deposits and withdrawals are both",
              "rejected."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "withdrawEvent",
      "docs": [
        "Emitted when the backend releases funds from the pool."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "docs": [
              "Wallet that received the lamports. The backend debits this key."
            ],
            "type": "pubkey"
          },
          {
            "name": "admin",
            "docs": [
              "Admin authority that approved the withdrawal."
            ],
            "type": "pubkey"
          },
          {
            "name": "amount",
            "docs": [
              "Lamports moved out of the pool vault."
            ],
            "type": "u64"
          },
          {
            "name": "vaultBalance",
            "docs": [
              "Pool vault lamports after the withdrawal, rent reserve included."
            ],
            "type": "u64"
          },
          {
            "name": "timestamp",
            "docs": [
              "Unix timestamp of the enclosing slot."
            ],
            "type": "i64"
          }
        ]
      }
    }
  ]
};
