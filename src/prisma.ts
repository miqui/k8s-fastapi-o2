import "./env";
import { PrismaClient } from "@prisma/client";

// Single shared client for the process - Prisma pools connections internally, same
// role as the single HikariCP-backed DataSource the old Spring app used.
export const prisma = new PrismaClient();
