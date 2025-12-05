//come as synchronus
//require("express");


//give error because of
//come as asynchronus
//for remove add type:"module" in package.json
import express from "express"
import cors from "cors"
//cud in cokies of browser by server
import cookieParser from "cookie-parser"
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const app=express()

app.use(cors({
    origin:process.env.CORS_ORIGIN,
    credentials:true
}))
//accept json
app.use(express.json({limit: "16kb"}))
//accept url encoded
app.use(express.urlencoded({extented:true,limit:"16kb"}))
//file,folder,public folder assets
app.use(express.static("public"))
//cud in cokies of browser by server
app.use(cookieParser())

app.use(helmet());
app.use(rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120 // tweak per your needs
}));


//routes import
import verifyroutes from './routes/verify.routes.js'

//routes decalaration
app.use("/api/v1/",verifyroutes)



export {app}